// @ts-strict-ignore
// Copyright (c) 2021-2023 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

import {
  GenericDataListenerSync,
  MathUtils,
  Airport,
  LegType,
  Runway,
  VhfNavaidType,
  WaypointDescriptor,
  EfisOption,
  EfisNdMode,
  NdSymbolTypeFlags,
  AltitudeDescriptor,
  EfisSide,
  Arinc429SignStatusMatrix,
  Arinc429LocalVarOutputWord,
  NearbyFacilityType,
  isNearbyVhfFacility,
  isMsfs2024,
  WaypointConstraintType,
  InternalFmsSymbol,
  NdSymbol,
  VdSymbol,
  FmsData,
  NdPwpSymbolTypeFlags,
} from '@flybywiresim/fbw-sdk';

import { Coordinates } from '@fmgc/flightplanning/data/geo';
import { Geometry } from '@fmgc/guidance/Geometry';
import { GuidanceController } from '@fmgc/guidance/GuidanceController';
import { bearingTo, distanceTo, placeBearingDistance } from 'msfs-geo';
import { LnavConfig } from '@fmgc/guidance/LnavConfig';
import { SegmentClass } from '@fmgc/flightplanning/segments/SegmentClass';
import { FlightPlan } from '@fmgc/flightplanning/plans/FlightPlan';
import { FlightPlanIndex } from '@fmgc/flightplanning/FlightPlanManager';
import { BaseFlightPlan } from '@fmgc/flightplanning/plans/BaseFlightPlan';
import { AlternateFlightPlan } from '@fmgc/flightplanning/plans/AlternateFlightPlan';
import { NavaidTuner } from '@fmgc/navigation/NavaidTuner';
import { FmgcFlightPhase } from '@shared/flightphase';
import { FlightPlanLeg } from '@fmgc/flightplanning/legs/FlightPlanLeg';

import { FlightPlanService } from '@fmgc/flightplanning/FlightPlanService';
import { VnavConfig } from '@fmgc/guidance/vnav/VnavConfig';
import { EfisInterface } from '@fmgc/efis/EfisInterface';
import { ConsumerValue, EventBus } from '@microsoft/msfs-sdk';
import { FlightPhaseManagerEvents } from '@fmgc/flightphase';
import { NavigationDatabaseService } from '../flightplanning/NavigationDatabaseService';
import { NavGeometryProfile } from '@fmgc/guidance/vnav/profile/NavGeometryProfile';
import { FlightPlanSegment } from '../flightplanning/segments/FlightPlanSegment';

/**
 * A map edit area in nautical miles, [ahead, behind, beside].
 */
type EditArea = [number, number, number];

export class EfisSymbols<T extends number> {
  private blockUpdate = false;

  private syncer: GenericDataListenerSync = new GenericDataListenerSync();

  private lastMode = -1;

  private lastRange = 0;

  private lastEfisOption = 0;

  private lastPpos: Coordinates = { lat: 0, long: 0 };

  private lastMrp: Coordinates = { lat: 0, long: 0 };

  private lastTrueHeading: number = -1;

  private nearbyFacilitesChanged = false;

  private lastFpVersions: Record<number, number> = {};

  private lastNavaidVersion = -1;

  private lastVnavDriverVersion: number = -1;

  private lastEfisInterfaceVersion = -1;

  private mapReferenceLatitude = new Arinc429LocalVarOutputWord(`L:A32NX_EFIS_${this.side}_MRP_LAT`);

  private mapReferenceLongitude = new Arinc429LocalVarOutputWord(`L:A32NX_EFIS_${this.side}_MRP_LONG`);

  private readonly flightPhase = ConsumerValue.create(
    this.bus.getSubscriber<FlightPhaseManagerEvents>().on('fmgc_flight_phase'),
    FmgcFlightPhase.Preflight,
  );

  private readonly syncEvent = `A32NX_EFIS_${this.side}_SYMBOLS` as const;

  private readonly nearbyAirportMonitor = NavigationDatabaseService.activeDatabase.createNearbyFacilityMonitor(
    NearbyFacilityType.Airport,
  );
  private readonly nearbyNdbNavaidMonitor = NavigationDatabaseService.activeDatabase.createNearbyFacilityMonitor(
    NearbyFacilityType.NdbNavaid,
  );
  private readonly nearbyVhfNavaidMonitor = NavigationDatabaseService.activeDatabase.createNearbyFacilityMonitor(
    NearbyFacilityType.VhfNavaid,
  );
  private readonly nearbyWaypointMonitor = NavigationDatabaseService.activeDatabase.createNearbyFacilityMonitor(
    NearbyFacilityType.Waypoint,
  );

  constructor(
    private readonly bus: EventBus,
    private readonly side: EfisSide,
    private readonly guidanceController: GuidanceController,
    private readonly flightPlanService: FlightPlanService,
    private readonly navaidTuner: NavaidTuner,
    private readonly efisInterface: EfisInterface,
    private readonly rangeValues: T[], // TODO factor this out of here. The EfisInterface should directly supply a edit area
    private readonly transmitVd: boolean = false,
  ) {
    this.nearbyAirportMonitor.setMaxResults(100);
    this.nearbyNdbNavaidMonitor.setMaxResults(100);
    this.nearbyVhfNavaidMonitor.setMaxResults(100);
    this.nearbyWaypointMonitor.setMaxResults(200);

    const setNearbyFacilitiesChanged = () => (this.nearbyFacilitesChanged = true);

    this.nearbyAirportMonitor.addListener(setNearbyFacilitiesChanged, setNearbyFacilitiesChanged);
    this.nearbyNdbNavaidMonitor.addListener(setNearbyFacilitiesChanged, setNearbyFacilitiesChanged);
    this.nearbyVhfNavaidMonitor.addListener(setNearbyFacilitiesChanged, setNearbyFacilitiesChanged);
    this.nearbyWaypointMonitor.addListener(setNearbyFacilitiesChanged, setNearbyFacilitiesChanged);
  }

  init(): void {}

  /**
   *
   * @param ll The latitude/longitude to check.
   * @param mrp The map reference point. If not defined nothing can be in the edit area as it is undefined.
   * @param mapOrientation The direction of the top of the map in true degrees.
   * @param editArea The map edit area in nautical miles, [ahead, behind, beside].
   * @returns true if {@link ll} lies within the edit area.
   */
  private isWithinEditArea(
    ll: Coordinates,
    mrp: Coordinates | null,
    mapOrientation: number,
    editArea: EditArea,
  ): boolean {
    if (!mrp) {
      return false;
    }

    const dist = distanceTo(mrp, ll);
    const bearing = MathUtils.normalise360(bearingTo(mrp, ll) - mapOrientation) * MathUtils.DEGREES_TO_RADIANS;
    const dx = dist * Math.sin(bearing);
    const dy = dist * Math.cos(bearing);
    return Math.abs(dx) < editArea[2] && dy > -editArea[1] && dy < editArea[0];
  }

  /**
   * Calculates the smallest circle that encompasses the entire edit area.
   * @param editArea The edit area.
   * @param mrp The map reference point associated with the edit area.
   * @param mapOrientation The upward direction of the map in degrees true.
   * @returns The required radius and centre point.
   */
  private static calculateNearbyParams(
    editArea: EditArea,
    mrp: Coordinates,
    mapOrientation: number,
  ): [number, Coordinates] {
    const halfWidth = editArea[2];
    const halfHeight = (editArea[0] + editArea[1]) / 2;
    const radius = Math.hypot(halfWidth, halfHeight);
    const upOffset = halfHeight - editArea[1];
    const centre = placeBearingDistance(mrp, mapOrientation, upOffset);
    return [radius, centre];
  }

  async update(): Promise<void> {
    if (this.blockUpdate) {
      return;
    }

    // TODO use FMGC position
    const ppos = {
      lat: SimVar.GetSimVarValue('PLANE LATITUDE', 'degree latitude'),
      long: SimVar.GetSimVarValue('PLANE LONGITUDE', 'degree longitude'),
    };
    const trueHeading = SimVar.GetSimVarValue('PLANE HEADING DEGREES TRUE', 'degrees');

    const mode: EfisNdMode = SimVar.GetSimVarValue(`L:A32NX_EFIS_${this.side}_ND_MODE`, 'number');

    // TODO planar distance in msfs-geo
    const mapReferencePoint = mode === EfisNdMode.PLAN ? this.findPlanCentreCoordinates() ?? ppos : ppos;
    const mrpChanged = distanceTo(this.lastMrp, mapReferencePoint) > 2;
    if (mrpChanged) {
      this.lastMrp = mapReferencePoint;
      this.lastPpos = ppos;
    }
    const trueHeadingChanged = MathUtils.diffAngle(trueHeading, this.lastTrueHeading) > 2;
    if (trueHeadingChanged) {
      this.lastTrueHeading = trueHeading;
    }

    const activeFpVersion = this.flightPlanService.has(FlightPlanIndex.Active)
      ? this.flightPlanService.active.version
      : -1;
    const tempFpVersion = this.flightPlanService.has(FlightPlanIndex.Temporary)
      ? this.flightPlanService.temporary.version
      : -1;
    const secFpVersion = this.flightPlanService.has(FlightPlanIndex.FirstSecondary)
      ? this.flightPlanService.secondary(1).version
      : -1;

    const activeFPVersionChanged = this.lastFpVersions[FlightPlanIndex.Active] !== activeFpVersion;
    const tempFPVersionChanged = this.lastFpVersions[FlightPlanIndex.Temporary] !== tempFpVersion;
    const secFPVersionChanged = this.lastFpVersions[FlightPlanIndex.FirstSecondary] !== secFpVersion;

    const fpChanged = activeFPVersionChanged || tempFPVersionChanged || secFPVersionChanged;

    this.lastFpVersions[FlightPlanIndex.Active] = activeFpVersion;
    this.lastFpVersions[FlightPlanIndex.Temporary] = tempFpVersion;
    this.lastFpVersions[FlightPlanIndex.FirstSecondary] = secFpVersion;

    const navaidsChanged = this.lastNavaidVersion !== this.navaidTuner.navaidVersion;
    this.lastNavaidVersion = this.navaidTuner.navaidVersion;

    const vnavPredictionsChanged = this.lastVnavDriverVersion !== this.guidanceController.vnavDriver.version;
    this.lastVnavDriverVersion = this.guidanceController.vnavDriver.version;

    // const hasSuitableRunway = (airport: Airport): boolean =>
    //   airport.longestRunwayLength >= 1500 && airport.longestRunwaySurfaceType === RunwaySurfaceType.Hard;

    const range = this.rangeValues[SimVar.GetSimVarValue(`L:A32NX_EFIS_${this.side}_ND_RANGE`, 'number')];
    const efisOption = SimVar.GetSimVarValue(`L:A32NX_EFIS_${this.side}_OPTION`, 'Enum');

    const rangeChange = this.lastRange !== range;
    this.lastRange = range;
    const modeChange = this.lastMode !== mode;
    this.lastMode = mode;
    const efisOptionChange = this.lastEfisOption !== efisOption;
    this.lastEfisOption = efisOption;
    this.nearbyFacilitesChanged &&= (efisOption & ~EfisOption.Constraints) > 0;
    const efisInterfaceChanged = this.lastEfisInterfaceVersion !== this.efisInterface.version;
    this.lastEfisInterfaceVersion = this.efisInterface.version;

    /** True bearing of the up direction of the map in degrees. */
    const mapOrientation = mode === EfisNdMode.PLAN ? 0 : trueHeading;
    const editArea = this.calculateEditArea(range, mode);

    // MSFS2024 can load facs much more efficiently with minimal facilities, so we can afford to follow the MRP in plan mode.
    const nearbyMrp = isMsfs2024() ? mapReferencePoint : ppos;
    const [nearbyRadius, nearbyCentre] = EfisSymbols.calculateNearbyParams(editArea, nearbyMrp, mapOrientation);
    if (efisOption & EfisOption.Airports) {
      this.nearbyAirportMonitor.setLocation(nearbyCentre.lat, nearbyCentre.long);
      this.nearbyAirportMonitor.setRadius(nearbyRadius);
    }
    if (efisOption & EfisOption.Ndbs) {
      this.nearbyNdbNavaidMonitor.setLocation(nearbyCentre.lat, nearbyCentre.long);
      this.nearbyNdbNavaidMonitor.setRadius(nearbyRadius);
    }
    if (efisOption & EfisOption.VorDmes) {
      this.nearbyVhfNavaidMonitor.setLocation(nearbyCentre.lat, nearbyCentre.long);
      this.nearbyVhfNavaidMonitor.setRadius(nearbyRadius);
    }
    if (efisOption & EfisOption.Waypoints) {
      this.nearbyWaypointMonitor.setLocation(nearbyCentre.lat, nearbyCentre.long);
      this.nearbyWaypointMonitor.setRadius(nearbyRadius);
    }

    if (
      !mrpChanged &&
      !trueHeadingChanged &&
      !rangeChange &&
      !modeChange &&
      !efisOptionChange &&
      !this.nearbyFacilitesChanged &&
      !fpChanged &&
      !navaidsChanged &&
      !vnavPredictionsChanged &&
      !efisInterfaceChanged
    ) {
      return;
    }

    if (mapReferencePoint) {
      this.mapReferenceLatitude.setBnrValue(
        mapReferencePoint.lat,
        Arinc429SignStatusMatrix.NormalOperation,
        20,
        90,
        -90,
      );
      this.mapReferenceLongitude.setBnrValue(
        mapReferencePoint.long,
        Arinc429SignStatusMatrix.NormalOperation,
        20,
        180,
        -180,
      );
    } else {
      this.mapReferenceLatitude.setBnrValue(0, Arinc429SignStatusMatrix.NoComputedData, 20, 90, -90);
      this.mapReferenceLongitude.setBnrValue(0, Arinc429SignStatusMatrix.NoComputedData, 20, 180, -180);
    }

    this.mapReferenceLatitude.writeToSimVarIfDirty();
    this.mapReferenceLongitude.writeToSimVarIfDirty();

    if (mode === EfisNdMode.PLAN && !mapReferencePoint) {
      this.syncer.sendEvent(this.syncEvent, []);
      return;
    }

    const symbols: InternalFmsSymbol[] = [];

    // symbols most recently inserted always end up at the end of the array
    // we reverse the array at the end to make sure symbols are drawn in the correct order
    // eslint-disable-next-line no-loop-func
    const upsertSymbol = (symbol: InternalFmsSymbol): void => {
      // for symbols with no databaseId, we don't bother trying to de-duplicate as we cannot do it safely
      const symbolIdx = symbol.databaseId ? symbols.findIndex((s) => s.databaseId === symbol.databaseId) : -1;
      if (symbolIdx !== -1) {
        const oldSymbol = symbols.splice(symbolIdx, 1)[0];
        symbol.constraints = symbol.constraints ?? oldSymbol.constraints;
        symbol.direction = symbol.direction ?? oldSymbol.direction;
        symbol.length = symbol.length ?? oldSymbol.length;
        symbol.location = symbol.location ?? oldSymbol.location;
        symbol.type |= oldSymbol.type;
        if (oldSymbol.typePwp) {
          symbol.typePwp |= oldSymbol.typePwp;
        }
        if (oldSymbol.radials) {
          if (symbol.radials) {
            symbol.radials.push(...oldSymbol.radials);
          } else {
            symbol.radials = oldSymbol.radials;
          }
        }
        if (oldSymbol.radii) {
          if (symbol.radii) {
            symbol.radii.push(...oldSymbol.radii);
          } else {
            symbol.radii = oldSymbol.radii;
          }
        }
      }
      symbols.push(symbol);
    };

    // TODO ADIRs aligned (except in plan mode...?)
    if ((efisOption & EfisOption.VorDmes) > 0) {
      for (const vor of this.nearbyVhfNavaidMonitor.getCurrentFacilities()) {
        if (!isNearbyVhfFacility(vor)) {
          continue;
        }
        const symbolType = this.vorDmeTypeFlag(vor.vhfType);
        if (symbolType === 0) {
          continue;
        }
        if (this.isWithinEditArea(vor.location, mapReferencePoint, mapOrientation, editArea)) {
          upsertSymbol({
            databaseId: vor.databaseId,
            ident: vor.ident,
            location: vor.location,
            type: symbolType | NdSymbolTypeFlags.EfisOption,
          });
        }
      }
    }
    if ((efisOption & EfisOption.Ndbs) > 0) {
      for (const ndb of this.nearbyNdbNavaidMonitor.getCurrentFacilities()) {
        if (this.isWithinEditArea(ndb.location, mapReferencePoint, mapOrientation, editArea)) {
          upsertSymbol({
            databaseId: ndb.databaseId,
            ident: ndb.ident,
            location: ndb.location,
            type: NdSymbolTypeFlags.Ndb | NdSymbolTypeFlags.EfisOption,
          });
        }
      }
    }
    if ((efisOption & EfisOption.Airports) > 0) {
      for (const ap of this.nearbyAirportMonitor.getCurrentFacilities()) {
        if (
          this.isWithinEditArea(ap.location, mapReferencePoint, mapOrientation, editArea) /* && hasSuitableRunway(ap)*/
        ) {
          upsertSymbol({
            databaseId: ap.databaseId,
            ident: ap.ident,
            location: ap.location,
            type: NdSymbolTypeFlags.Airport | NdSymbolTypeFlags.EfisOption,
          });
        }
      }
    }
    if ((efisOption & EfisOption.Waypoints) > 0) {
      for (const wp of this.nearbyWaypointMonitor.getCurrentFacilities()) {
        if (this.isWithinEditArea(wp.location, mapReferencePoint, mapOrientation, editArea)) {
          upsertSymbol({
            databaseId: wp.databaseId,
            ident: wp.ident,
            location: wp.location,
            type: NdSymbolTypeFlags.Waypoint | NdSymbolTypeFlags.EfisOption,
          });
        }
      }
    }

    const formatConstraintAlt = (alt: number, descent: boolean, prefix: string = '') => {
      const transAlt = this.flightPlanService.active?.performanceData.transitionAltitude;
      const transFl = this.flightPlanService.active?.performanceData.transitionLevel;

      if (descent) {
        const fl = Math.round(alt / 100);
        if (transFl && fl >= transFl) {
          return `${prefix}FL${fl}`;
        }
      } else if (transAlt && alt >= transAlt) {
        return `${prefix}FL${Math.round(alt / 100)}`;
      }
      return `${prefix}${Math.round(alt)}`;
    };

    const formatConstraintSpeed = (speed: number, prefix: string = '') => `${prefix}${Math.floor(speed)}KT`;

    // TODO don't send the waypoint before active once FP sequencing is properly implemented
    // (currently sequences with guidance which is too early)
    // eslint-disable-next-line no-lone-blocks

    // ACTIVE
    if (this.flightPlanService.hasActive && this.guidanceController.hasGeometryForFlightPlan(FlightPlanIndex.Active)) {
      const symbols = this.getFlightPlanSymbols(
        false,
        this.flightPlanService.active,
        this.guidanceController.activeGeometry,
        range,
        efisOption,
        mode,
        this.side,
        mapReferencePoint,
        mapOrientation,
        editArea,
        formatConstraintAlt,
        formatConstraintSpeed,
        this.guidanceController.vnavDriver.mcduProfile,
      );

      for (const symbol of symbols) {
        upsertSymbol(symbol);
      }

      // ACTIVE ALTN
      if (
        this.flightPlanService.active.alternateFlightPlan.legCount > 0 &&
        this.guidanceController.hasGeometryForFlightPlan(FlightPlanIndex.Active) &&
        this.efisInterface.shouldTransmitAlternate(FlightPlanIndex.Active, mode === EfisNdMode.PLAN)
      ) {
        const symbols = this.getFlightPlanSymbols(
          true,
          this.flightPlanService.active.alternateFlightPlan,
          this.guidanceController.getGeometryForFlightPlan(FlightPlanIndex.Active, true),
          range,
          efisOption,
          mode,
          this.side,
          mapReferencePoint,
          mapOrientation,
          editArea,
          formatConstraintAlt,
          formatConstraintSpeed,
        );

        for (const symbol of symbols) {
          upsertSymbol(symbol);
        }
      }
    }

    // TMPY
    if (
      this.flightPlanService.hasTemporary &&
      this.guidanceController.hasGeometryForFlightPlan(FlightPlanIndex.Temporary)
    ) {
      const symbols = this.getFlightPlanSymbols(
        false,
        this.flightPlanService.temporary,
        this.guidanceController.temporaryGeometry,
        range,
        efisOption,
        mode,
        this.side,
        mapReferencePoint,
        mapOrientation,
        editArea,
        formatConstraintAlt,
        formatConstraintSpeed,
      );

      for (const symbol of symbols) {
        upsertSymbol(symbol);
      }
    }

    // SEC
    if (
      this.flightPlanService.hasSecondary(1) &&
      this.guidanceController.hasGeometryForFlightPlan(FlightPlanIndex.FirstSecondary) &&
      this.efisInterface.shouldTransmitSecondary()
    ) {
      const symbols = this.getFlightPlanSymbols(
        false,
        this.flightPlanService.secondary(1),
        this.guidanceController.secondaryGeometry,
        range,
        efisOption,
        mode,
        this.side,
        mapReferencePoint,
        mapOrientation,
        editArea,
        formatConstraintAlt,
        formatConstraintSpeed,
      );

      for (const symbol of symbols) {
        upsertSymbol(symbol);
      }

      // SEC ALTN
      if (
        this.flightPlanService.secondary(1).alternateFlightPlan.legCount > 0 &&
        this.guidanceController.hasGeometryForFlightPlan(FlightPlanIndex.FirstSecondary) &&
        this.efisInterface.shouldTransmitAlternate(FlightPlanIndex.FirstSecondary, mode === EfisNdMode.PLAN)
      ) {
        const symbols = this.getFlightPlanSymbols(
          true,
          this.flightPlanService.secondary(1).alternateFlightPlan,
          this.guidanceController.getGeometryForFlightPlan(FlightPlanIndex.FirstSecondary, true),
          range,
          efisOption,
          mode,
          this.side,
          mapReferencePoint,
          mapOrientation,
          editArea,
          formatConstraintAlt,
          formatConstraintSpeed,
        );

        for (const symbol of symbols) {
          upsertSymbol(symbol);
        }
      }
    }

    // Pseudo waypoints

    for (const pwp of this.guidanceController.currentPseudoWaypoints.filter((it) => it && it.displayedOnNd)) {
      // Some PWP are only relevant for a specific display side
      if (
        (this.side === 'L' && pwp.efisSymbolFlag & NdSymbolTypeFlags.RightSideOnly) ||
        (this.side === 'R' && pwp.efisSymbolFlag & NdSymbolTypeFlags.LeftSideOnly)
      ) {
        continue;
      }

      // End of VD marker needs direction
      let direction: number | undefined = undefined;

      if (
        pwp.efisPwpSymbolFlag & NdPwpSymbolTypeFlags.PwpEndOfVdMarker &&
        this.guidanceController.activeGeometry.legs.has(pwp.alongLegIndex)
      ) {
        const leg = this.guidanceController.activeGeometry.legs.get(pwp.alongLegIndex);
        const orientation = Geometry.getLegOrientationAtDistanceFromEnd(leg, pwp.distanceFromLegTermination);
        if (orientation !== null) {
          direction = orientation;
        }
      }

      upsertSymbol({
        databaseId: `W      ${pwp.ident}`,
        ident: pwp.ident,
        location: pwp.efisSymbolLla,
        direction,
        type: pwp.efisSymbolFlag,
        typePwp: pwp.efisPwpSymbolFlag,
        // When in HDG/TRK, this defines where on the track line the PWP lies
        distanceFromAirplane: pwp.distanceFromStart,
        predictedAltitude: pwp.flightPlanInfo?.altitude ?? undefined,
      });
    }

    for (const ndb of this.navaidTuner.tunedNdbs) {
      upsertSymbol({
        databaseId: ndb.databaseId,
        ident: ndb.ident,
        location: ndb.location,
        type: NdSymbolTypeFlags.Ndb | NdSymbolTypeFlags.Tuned,
      });
    }

    for (const vor of this.navaidTuner.tunedVors) {
      upsertSymbol({
        databaseId: vor.databaseId,
        ident: vor.ident,
        location: vor.location,
        type: this.vorDmeTypeFlag(vor.type) | NdSymbolTypeFlags.Tuned,
      });
    }

    const wordsPerSymbol = 6;
    const maxSymbols = 640 / wordsPerSymbol;
    if (symbols.length > maxSymbols) {
      symbols.splice(0, symbols.length - maxSymbols);
      // FIXME should not reach into guidanceController like that. It should really be part of EfisInterface anyhow
      this.guidanceController.efisStateForSide[this.side].dataLimitReached = true;
    } else {
      this.guidanceController.efisStateForSide[this.side].dataLimitReached = false;
    }

    this.transmitNdSymbols(symbols);

    if (this.transmitVd) {
      this.transmitVdSymbols(symbols);
    }

    // make sure we don't run too often
    this.blockUpdate = true;
    setTimeout(() => {
      this.blockUpdate = false;
    }, 200);
  }

  private getFlightPlanSymbols(
    isAlternate: boolean,
    flightPlan: BaseFlightPlan,
    geometry: Geometry,
    range: NauticalMiles,
    efisOption: EfisOption,
    mode: EfisNdMode,
    side: EfisSide,
    mapReferencePoint: Coordinates | null,
    mapOrientation: number,
    editArea: EditArea,
    formatConstraintAlt: (alt: number, descent: boolean, prefix?: string) => string,
    formatConstraintSpeed: (speed: number, prefix?: string) => string,
    predictions?: NavGeometryProfile,
  ): InternalFmsSymbol[] {
    const isInLatAutoControl = this.guidanceController.vnavDriver.isLatAutoControlActive();
    const isLatAutoControlArmed = this.guidanceController.vnavDriver.isLatAutoControlArmedWithIntercept();
    const waypointPredictions = this.guidanceController.vnavDriver.mcduProfile?.waypointPredictions;
    const isSelectedVerticalModeActive = this.guidanceController.vnavDriver.isSelectedVerticalModeActive();
    const flightPhase = this.flightPhase.get();

    const isPlanMode = mode === EfisNdMode.PLAN;

    const transmitMissed = isAlternate
      ? this.efisInterface.shouldTransmitAlternateMissed(flightPlan.index, isPlanMode)
      : this.efisInterface.shouldTransmitMissed(flightPlan.index, isPlanMode);

    const ret: InternalFmsSymbol[] = [];

    // FP legs
    for (let i = flightPlan.legCount - 1; i >= flightPlan.fromLegIndex && i >= 0; i--) {
      const isBeforeActiveLeg = i < flightPlan.activeLegIndex;

      const leg = flightPlan.elementAt(i);

      if (leg.isDiscontinuity === true) {
        continue;
      }

      if (
        leg.definition.waypointDescriptor === WaypointDescriptor.Airport ||
        leg.definition.waypointDescriptor === WaypointDescriptor.Runway
      ) {
        // we pick these up later
        continue;
      }

      // no symbols for manual legs, except FM leg with no leg before it
      if (
        leg.definition.type === LegType.VM ||
        (leg.definition.type === LegType.FM && !flightPlan.maybeElementAt(i - 1)?.isDiscontinuity)
      ) {
        continue;
      }

      // if range >= 160, don't include terminal waypoints, except at enroute boundary
      if (range >= 160) {
        // FIXME the enroute boundary condition has been removed in fms-v2...
        const [segment] = flightPlan.segmentPositionForIndex(i);
        if (segment.class === SegmentClass.Departure || segment.class === SegmentClass.Arrival) {
          continue;
        }
      }

      let location;
      let databaseId;

      const geometryLeg = geometry.legs.get(i);

      if (geometryLeg) {
        const terminationWaypoint = geometryLeg.terminationWaypoint;

        if (terminationWaypoint) {
          if ('lat' in terminationWaypoint) {
            location = terminationWaypoint;
            databaseId = `X${Math.round(Math.random() * 1_000)
              .toString()
              .padStart(6, '0')}${leg.ident.substring(0, 5)}`;
          } else {
            location = terminationWaypoint.location;
            databaseId = terminationWaypoint.databaseId;
          }
        }
      }

      if (!location) {
        location = leg.terminationWaypoint()?.location;
        databaseId = leg.terminationWaypoint()?.databaseId;
      }

      if (!location) {
        continue;
      }

      if (!this.isWithinEditArea(location, mapReferencePoint, mapOrientation, editArea)) {
        continue;
      }

      let type = NdSymbolTypeFlags.FlightPlan;
      const constraints = [];
      let direction;

      const isCourseReversal =
        leg.type === LegType.HA || leg.type === LegType.HF || leg.type === LegType.HM || leg.type === LegType.PI;

      if (i === flightPlan.activeLegIndex && !isAlternate) {
        type |= NdSymbolTypeFlags.ActiveLegTermination;
      } else if (
        isCourseReversal &&
        i > flightPlan.activeLegIndex + 1 &&
        range <= 80 &&
        !LnavConfig.DEBUG_FORCE_INCLUDE_COURSE_REVERSAL_VECTORS
      ) {
        if (leg.definition.turnDirection === 'L') {
          type |= NdSymbolTypeFlags.CourseReversalLeft;
        } else {
          type |= NdSymbolTypeFlags.CourseReversalRight;
        }
        direction = leg.definition.magneticCourse; // TODO true
      }

      if (i >= flightPlan.firstMissedApproachLegIndex && !transmitMissed) {
        continue;
      }

      const altConstraint = leg.altitudeConstraint;

      if (
        (isInLatAutoControl || isLatAutoControlArmed) &&
        !isBeforeActiveLeg &&
        altConstraint &&
        shouldShowConstraintCircleInPhase(flightPhase, leg) &&
        !isAlternate &&
        !leg.isXA()
      ) {
        if (!isSelectedVerticalModeActive) {
          type |= NdSymbolTypeFlags.Constraint;

          const predictionAtWaypoint = waypointPredictions?.get(i);

          if (predictionAtWaypoint?.isAltitudeConstraintMet) {
            type |= NdSymbolTypeFlags.MagentaColor;
          } else if (predictionAtWaypoint) {
            type |= NdSymbolTypeFlags.AmberColor;
          }
        } else if (i === flightPlan.activeLegIndex) {
          type |= NdSymbolTypeFlags.Constraint;
        }
      }

      if ((efisOption & EfisOption.Constraints) > 0 && !isBeforeActiveLeg) {
        if (!leg.isXA()) {
          const descent = leg.constraintType === WaypointConstraintType.DES;
          switch (altConstraint?.altitudeDescriptor) {
            case AltitudeDescriptor.AtAlt1:
            case AltitudeDescriptor.AtAlt1GsIntcptAlt2:
            case AltitudeDescriptor.AtAlt1AngleAlt2:
              constraints.push(formatConstraintAlt(altConstraint.altitude1, descent));
              break;
            case AltitudeDescriptor.AtOrAboveAlt1:
            case AltitudeDescriptor.AtOrAboveAlt1GsIntcptAlt2:
            case AltitudeDescriptor.AtOrAboveAlt1AngleAlt2:
              constraints.push(formatConstraintAlt(altConstraint.altitude1, descent, '+'));
              break;
            case AltitudeDescriptor.AtOrBelowAlt1:
            case AltitudeDescriptor.AtOrBelowAlt1AngleAlt2:
              constraints.push(formatConstraintAlt(altConstraint.altitude1, descent, '-'));
              break;
            case AltitudeDescriptor.BetweenAlt1Alt2:
              constraints.push(formatConstraintAlt(altConstraint.altitude1, descent, '-'));
              constraints.push(formatConstraintAlt(altConstraint.altitude2, descent, '+'));
              break;
            case AltitudeDescriptor.AtOrAboveAlt2:
              constraints.push(formatConstraintAlt(altConstraint.altitude2, descent, '+'));
              break;
            default:
              // No constraint
              break;
          }
        }

        const speedConstraint = leg.speedConstraint;

        if (speedConstraint) {
          constraints.push(formatConstraintSpeed(speedConstraint.speed));
        }
      }

      if (VnavConfig.DEBUG_GUIDANCE && leg.calculated) {
        constraints.push(`${Math.round(leg.calculated.cumulativeDistanceWithTransitions)}NM`);
        constraints.push(`${Math.round(leg.calculated.cumulativeDistanceToEndWithTransitions)}NM`);
      }

      const distanceFromAirplane =
        predictions && predictions.waypointPredictions.has(i)
          ? predictions.waypointPredictions.get(i).distanceFromAircraft
          : undefined;

      const predictedAltitude =
        predictions && predictions.waypointPredictions.has(i)
          ? predictions.waypointPredictions.get(i).altitude
          : undefined;

      ret.push({
        databaseId,
        ident: leg.ident,
        location,
        type,
        constraints: constraints.length > 0 ? constraints : undefined,
        altConstraint: leg.altitudeConstraint,
        isAltitudeConstraintMet:
          predictions && predictions.waypointPredictions.has(i)
            ? predictions.waypointPredictions.get(i).isAltitudeConstraintMet
            : true,
        direction,
        distanceFromAirplane,
        predictedAltitude,
      });
    }

    // we can only send 2 constraint predictions, so filter out any past the 2 close to the AC
    let constraintPredictions = 0;
    const constraintFlags =
      NdSymbolTypeFlags.Constraint | NdSymbolTypeFlags.MagentaColor | NdSymbolTypeFlags.AmberColor;
    for (let i = ret.length - 1; i >= 0; i--) {
      if ((ret[i].type & constraintFlags) === 0) {
        continue;
      }
      if (constraintPredictions >= 2) {
        ret[i].type &= ~constraintFlags;
      } else {
        constraintPredictions++;
      }
    }

    // FP airports/runways

    const airports: [Airport | undefined, Runway | undefined, FlightPlanSegment | undefined][] = [
      // The alternate origin airport symbol is not shown as it is the same as the primary destination
      [flightPlan.originAirport, flightPlan.originRunway, flightPlan.originSegment],
      [flightPlan.destinationAirport, flightPlan.destinationRunway, flightPlan.destinationSegment],
    ];

    for (const [airport, runway, segment] of airports) {
      if (!airport) {
        continue;
      }

      const planAltnStr = flightPlan instanceof AlternateFlightPlan ? 'A' : ' ';
      const planIndexStr = flightPlan.index.toString();
      const runwayIdentStr = runway?.ident.padEnd(8, ' ') ?? '        ';

      const databaseId = `A${airport.ident}${planAltnStr}${planIndexStr}${runwayIdentStr}`;

      const distanceFromAirplane =
        (segment.lastLeg?.calculated?.cumulativeDistanceWithTransitions ??
          distanceTo(this.lastPpos, airport.location)) -
        (this.guidanceController.vnavDriver.mcduProfile?.distanceToPresentPosition ?? 0);

      if (runway) {
        if (this.isWithinEditArea(runway.startLocation, mapReferencePoint, mapOrientation, editArea)) {
          ret.push({
            databaseId,
            ident: runway.ident,
            location: runway.startLocation,
            direction: runway.bearing,
            length: runway.length / MathUtils.METRES_TO_NAUTICAL_MILES,
            type: NdSymbolTypeFlags.Runway,
            distanceFromAirplane: distanceFromAirplane,
            predictedAltitude: runway.thresholdLocation.alt,
          });
        }
      } else if (this.isWithinEditArea(airport.location, mapReferencePoint, mapOrientation, editArea)) {
        ret.push({
          databaseId,
          ident: airport.ident,
          location: airport.location,
          type: NdSymbolTypeFlags.Airport | NdSymbolTypeFlags.FlightPlan,
          distanceFromAirplane: distanceFromAirplane,
          predictedAltitude: airport.location.alt,
        });
      }
    }

    // FP fix info
    if (flightPlan instanceof FlightPlan && flightPlan.index === FlightPlanIndex.Active && !isAlternate) {
      for (let i = 0; i < flightPlan.fixInfos.length; i++) {
        const fixInfo = flightPlan.fixInfos[i];

        if (!fixInfo) {
          continue;
        }

        ret.push({
          databaseId: fixInfo.fix.databaseId,
          ident: fixInfo.fix.ident,
          location: fixInfo.fix.location,
          type: NdSymbolTypeFlags.FixInfo,
          radials: fixInfo.radials?.map((it) => it.trueBearing),
          radii: fixInfo.radii?.map((it) => it.radius),
        });
      }
    }

    return ret;
  }

  private vorDmeTypeFlag(type: VhfNavaidType): NdSymbolTypeFlags {
    switch (type) {
      case VhfNavaidType.VorDme:
      case VhfNavaidType.Vortac:
        return NdSymbolTypeFlags.VorDme;
      case VhfNavaidType.Vor:
        return NdSymbolTypeFlags.Vor;
      case VhfNavaidType.Dme:
      case VhfNavaidType.Tacan:
        return NdSymbolTypeFlags.Dme;
      default:
        return 0;
    }
  }

  private calculateEditArea(range: T, mode: EfisNdMode): [number, number, number] {
    switch (mode) {
      case EfisNdMode.ARC:
        if (range <= 10) {
          return [10.5, 3.5, 8.3];
        }
        if (range <= 20) {
          return [20.5, 7, 16.6];
        }
        if (range <= 40) {
          return [40.5, 14, 33.2];
        }
        if (range <= 80) {
          return [80.5, 28, 66.4];
        }
        if (range <= 160) {
          return [160.5, 56, 132.8];
        }
        return [320.5, 112, 265.6];
      case EfisNdMode.ROSE_NAV:
        if (range <= 10) {
          return [7.6, 7.1, 7.1];
        }
        if (range <= 20) {
          return [14.7, 14.2, 14.2];
        }
        if (range <= 40) {
          return [28.9, 28.4, 28.4];
        }
        if (range <= 80) {
          return [57.3, 56.8, 56.8];
        }
        if (range <= 160) {
          return [114.1, 113.6, 113.6];
        }
        return [227.7, 227.2, 227.2];
      case EfisNdMode.PLAN:
        if (range <= 10) {
          return [7, 7, 7];
        }
        if (range <= 20) {
          return [14, 14, 14];
        }
        if (range <= 40) {
          return [28, 28, 28];
        }
        if (range <= 80) {
          return [56, 56, 56];
        }
        if (range <= 160) {
          return [112, 112, 112];
        }
        return [224, 224, 224];
      default:
        return [0, 0, 0];
    }
  }

  private findPlanCentreCoordinates(): Coordinates | null {
    // PLAN mode center
    const {
      fpIndex: focusedWpFpIndex,
      index: focusedWpIndex,
      inAlternate: focusedWpInAlternate,
    } = this.efisInterface.planCentre;

    if (!this.flightPlanService.has(focusedWpFpIndex)) {
      return null;
    }

    const plan = focusedWpInAlternate
      ? this.flightPlanService.get(focusedWpFpIndex).alternateFlightPlan
      : this.flightPlanService.get(focusedWpFpIndex);

    if (!plan.hasElement(focusedWpIndex)) {
      return null;
    }

    const matchingLeg = plan.elementAt(focusedWpIndex);

    if (!matchingLeg || matchingLeg.isDiscontinuity === true) {
      return null;
    }

    if (!this.guidanceController.hasGeometryForFlightPlan(focusedWpFpIndex, focusedWpInAlternate)) {
      return null;
    }

    const geometry = this.guidanceController.getGeometryForFlightPlan(focusedWpFpIndex, focusedWpInAlternate);
    const matchingGeometryLeg = geometry.legs.get(matchingLeg.isVectors() ? focusedWpIndex - 1 : focusedWpIndex);

    if (!matchingGeometryLeg?.terminationWaypoint) {
      return null;
    }

    if ('lat' in matchingGeometryLeg.terminationWaypoint) {
      return matchingGeometryLeg.terminationWaypoint;
    }

    return matchingGeometryLeg.terminationWaypoint.location;
  }

  private transmitNdSymbols(symbols: InternalFmsSymbol[]) {
    const ndSymbols: NdSymbol[] = symbols.map((s): NdSymbol => {
      return {
        databaseId: s.databaseId,
        ident: s.ident,
        location: s.location,
        direction: s.direction,
        length: s.length,
        type: s.type,
        typePwp: s.typePwp,
        constraints: s.constraints,
        radials: s.radials,
        radii: s.radii,
        distanceFromAirplane: s.distanceFromAirplane,
      };
    });
    this.syncer.sendEvent(this.syncEvent, ndSymbols);
  }

  private transmitVdSymbols(symbols: InternalFmsSymbol[]) {
    const vdSymbols: VdSymbol[] = symbols.map((s): VdSymbol => {
      return {
        databaseId: s.databaseId,
        ident: s.ident,
        location: s.location,
        predictedAltitude: s.predictedAltitude,
        direction: s.direction,
        length: s.length,
        type: s.type,
        typePwp: s.typePwp,
        constraints: s.constraints,
        altConstraint: s.altConstraint,
        isAltitudeConstraintMet: s.isAltitudeConstraintMet,
        distanceFromAirplane: s.distanceFromAirplane,
      };
    });
    this.bus.getPublisher<FmsData>().pub(`vdSymbols_${this.side}`, vdSymbols, true);
  }
}

const shouldShowConstraintCircleInPhase = (phase: FmgcFlightPhase, leg: FlightPlanLeg) =>
  (phase <= FmgcFlightPhase.Climb && leg.constraintType === WaypointConstraintType.CLB) ||
  ((phase === FmgcFlightPhase.Cruise || phase === FmgcFlightPhase.Descent || phase === FmgcFlightPhase.Approach) &&
    leg.constraintType === WaypointConstraintType.DES);
