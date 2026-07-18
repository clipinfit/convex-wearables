export type SyntheticProfile = "active" | "sedentary" | "recovery" | "mixed" | "showcase";

type DailySyntheticProfile = Exclude<SyntheticProfile, "mixed" | "showcase">;
type ShowcaseScoreTier = "perfect" | "strong" | "low";

export type SyntheticSummary = {
  date: string;
  category: "activity" | "sleep" | "recovery";
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  activeMinutes?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  sleepDurationMinutes?: number;
  sleepEfficiency?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  lightSleepMinutes?: number;
  awakeDuringMinutes?: number;
  timeInBedMinutes?: number;
  hrvAvg?: number;
  hrvRmssd?: number;
  restingHeartRate?: number;
  recoveryScore?: number;
  avgStressLevel?: number;
  bodyBattery?: number;
  spo2Avg?: number;
};

export type SyntheticEvent = {
  category: "workout" | "sleep";
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId: string;
  heartRateMin?: number;
  heartRateMax?: number;
  heartRateAvg?: number;
  energyBurned?: number;
  distance?: number;
  stepsCount?: number;
  movingTimeSeconds?: number;
  totalElevationGain?: number;
  sleepTotalDurationMinutes?: number;
  sleepTimeInBedMinutes?: number;
  sleepEfficiencyScore?: number;
  sleepDeepMinutes?: number;
  sleepRemMinutes?: number;
  sleepLightMinutes?: number;
  sleepAwakeMinutes?: number;
  isNap?: boolean;
  sleepStages?: Array<{ stage: string; startTime: number; endTime: number }>;
};

export type SyntheticDataPoint = {
  seriesType: string;
  recordedAt: number;
  value: number;
  externalId: string;
};

export type SyntheticDataPlan = {
  dates: string[];
  events: SyntheticEvent[];
  points: SyntheticDataPoint[];
  summaries: SyntheticSummary[];
};

const MAX_SYNTHETIC_DAYS = 31;
const DAY_IN_MS = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(random: () => number, minimum: number, maximum: number) {
  return minimum + (maximum - minimum) * random();
}

function randomInteger(random: () => number, minimum: number, maximum: number) {
  return Math.round(randomBetween(random, minimum, maximum));
}

function parseIsoDate(date: string) {
  if (!ISO_DATE_PATTERN.test(date)) {
    throw new Error(`Invalid ISO date "${date}". Expected YYYY-MM-DD.`);
  }

  const [year, month, day] = date.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  if (new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid calendar date "${date}".`);
  }
  return timestamp;
}

function addDays(date: string, amount: number) {
  return new Date(parseIsoDate(date) + amount * DAY_IN_MS).toISOString().slice(0, 10);
}

function enumerateDates(startDate: string, endDate: string) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (end < start) {
    throw new Error("Synthetic data endDate must be on or after startDate.");
  }

  const count = Math.floor((end - start) / DAY_IN_MS) + 1;
  if (count > MAX_SYNTHETIC_DAYS) {
    throw new Error(`Synthetic data ranges are limited to ${MAX_SYNTHETIC_DAYS} days.`);
  }

  return Array.from({ length: count }, (_, index) => addDays(startDate, index));
}

function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid timezone "${timezone}".`);
  }
}

function dayKeyForTimezone(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function zonedDateTimeToTimestamp(date: string, timezone: string, hour: number, minute = 0) {
  const [year, month, day] = date.split("-").map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetAsUtc;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    }).formatToParts(new Date(guess));
    const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const representedAsUtc = Date.UTC(
      numberPart("year"),
      numberPart("month") - 1,
      numberPart("day"),
      numberPart("hour"),
      numberPart("minute"),
    );
    guess += targetAsUtc - representedAsUtc;
  }

  return guess;
}

function profileForDay(profile: SyntheticProfile, dayIndex: number): DailySyntheticProfile {
  if (profile === "showcase") return "active";
  if (profile !== "mixed") return profile;
  return (["active", "recovery", "active", "sedentary"] as const)[dayIndex % 4];
}

function activityFactor(profile: DailySyntheticProfile) {
  if (profile === "active") return 1.15;
  if (profile === "sedentary") return 0.55;
  return 0.75;
}

function getIsoWeekStart(date: string) {
  const weekday = new Date(parseIsoDate(date)).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

function getShowcaseScoreTier(args: {
  date: string;
  seed: string;
  userId: string;
}): ShowcaseScoreTier {
  const weekStart = getIsoWeekStart(args.date);
  const weekdayIndex = Math.round((parseIsoDate(args.date) - parseIsoDate(weekStart)) / DAY_IN_MS);
  const weekdays = [0, 1, 2, 3, 4, 5, 6];
  const random = mulberry32(hashString([args.userId, weekStart, args.seed, "showcase"].join(":")));

  for (let index = weekdays.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(random, 0, index);
    [weekdays[index], weekdays[swapIndex]] = [
      weekdays[swapIndex] ?? index,
      weekdays[index] ?? swapIndex,
    ];
  }

  if (weekdayIndex === weekdays[0]) return "low";
  if (weekdayIndex === weekdays[1] || weekdayIndex === weekdays[2]) {
    return "strong";
  }
  return "perfect";
}

function buildSleepStages(args: {
  startTime: number;
  totalMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
}) {
  const lightMinutes = Math.max(args.totalMinutes - args.deepMinutes - args.remMinutes, 1);
  const firstLightMinutes = Math.round(lightMinutes * 0.2);
  const secondLightMinutes = Math.round(lightMinutes * 0.35);
  const finalLightMinutes = lightMinutes - firstLightMinutes - secondLightMinutes;
  const firstDeepMinutes = Math.round(args.deepMinutes * 0.65);
  const firstRemMinutes = Math.round(args.remMinutes * 0.4);
  const segments = [
    ["light", firstLightMinutes],
    ["deep", firstDeepMinutes],
    ["light", secondLightMinutes],
    ["rem", firstRemMinutes],
    ["awake", args.awakeMinutes],
    ["light", finalLightMinutes],
    ["deep", args.deepMinutes - firstDeepMinutes],
    ["rem", args.remMinutes - firstRemMinutes],
  ] as const;
  let cursor = args.startTime;

  return segments.map(([stage, minutes]) => {
    const endTime = cursor + minutes * 60_000;
    const result = { stage, startTime: cursor, endTime };
    cursor = endTime;
    return result;
  });
}

export function buildSyntheticDataPlan(args: {
  userId: string;
  startDate: string;
  endDate: string;
  timezone: string;
  asOf?: number;
  profile: SyntheticProfile;
  seed: string;
}): SyntheticDataPlan {
  assertTimezone(args.timezone);
  const asOf = args.asOf ?? Date.now();
  if (!Number.isFinite(asOf) || asOf < 0) {
    throw new Error("Synthetic data asOf must be a finite non-negative timestamp.");
  }
  const dates = enumerateDates(args.startDate, args.endDate);
  const asOfDay = dayKeyForTimezone(asOf, args.timezone);
  if (args.endDate > asOfDay) {
    throw new Error(`Synthetic data endDate cannot be after the asOf day ${asOfDay}.`);
  }
  const sourceName = "SynthDevice";
  const externalPrefix = `synthetic:${args.userId}`;
  const events: SyntheticEvent[] = [];
  const points: SyntheticDataPoint[] = [];
  const summaries: SyntheticSummary[] = [];

  dates.forEach((date) => {
    const dayOrdinal = Math.floor(parseIsoDate(date) / DAY_IN_MS);
    const random = mulberry32(hashString([args.userId, date, args.seed].join(":")));
    const dailyProfile = profileForDay(args.profile, dayOrdinal);
    const factor = activityFactor(dailyProfile);
    const showcaseTier =
      args.profile === "showcase"
        ? getShowcaseScoreTier({
            date,
            seed: args.seed,
            userId: args.userId,
          })
        : null;
    const showcaseScore =
      showcaseTier === "strong"
        ? randomInteger(random, 82, 89)
        : showcaseTier === "low"
          ? randomInteger(random, 62, 68)
          : showcaseTier === "perfect"
            ? 100
            : null;
    const steps = showcaseScore
      ? showcaseTier === "perfect"
        ? randomInteger(random, 7_000, 12_500)
        : Math.round(3_500 * (showcaseScore / 100))
      : dailyProfile === "sedentary"
        ? randomInteger(random, 2_450, 3_400)
        : Math.round(randomInteger(random, 6_500, 12_500) * factor);
    const activeCalories = showcaseScore
      ? showcaseTier === "perfect"
        ? randomInteger(random, 420, 720)
        : Math.round(350 * (showcaseScore / 100))
      : dailyProfile === "sedentary"
        ? randomInteger(random, 255, 340)
        : Math.round(randomInteger(random, 350, 650) * factor);
    const activeMinutes = showcaseScore
      ? showcaseTier === "perfect"
        ? randomInteger(random, 55, 105)
        : Math.round(60 * (showcaseScore / 100))
      : dailyProfile === "sedentary"
        ? randomInteger(random, 20, 42)
        : Math.round(randomInteger(random, 45, 90) * factor);
    const restingHeartRate =
      dailyProfile === "sedentary"
        ? randomInteger(random, 61, 70)
        : dailyProfile === "recovery"
          ? randomInteger(random, 52, 61)
          : randomInteger(random, 49, 59);
    const hrv =
      dailyProfile === "recovery" ? randomInteger(random, 62, 82) : randomInteger(random, 42, 70);
    const recoveryScore =
      dailyProfile === "recovery" ? randomInteger(random, 82, 96) : randomInteger(random, 62, 90);
    const bodyBattery = randomInteger(random, 58, 94);
    const stress = randomInteger(random, 20, 48);
    const spo2 = Math.round(randomBetween(random, 95.5, 99) * 10) / 10;
    const totalSleepMinutes = showcaseScore
      ? showcaseTier === "perfect"
        ? randomInteger(random, 425, 500)
        : Math.round(420 * (showcaseScore / 100))
      : dailyProfile === "sedentary"
        ? randomInteger(random, 355, 410)
        : dailyProfile === "recovery"
          ? randomInteger(random, 455, 525)
          : randomInteger(random, 390, 490);
    const deepMinutes = randomInteger(random, 65, 110);
    const remMinutes = randomInteger(random, 80, 125);
    const awakeMinutes = randomInteger(random, 12, 32);
    const lightMinutes = Math.max(totalSleepMinutes - deepMinutes - remMinutes, 120);
    const timeInBedMinutes = totalSleepMinutes + awakeMinutes;
    const sleepStart = zonedDateTimeToTimestamp(
      addDays(date, -1),
      args.timezone,
      22,
      randomInteger(random, 10, 55),
    );
    const sleepEnd = sleepStart + timeInBedMinutes * 60_000;
    const avgHeartRate = randomInteger(random, 69, 82);
    const maxHeartRate = randomInteger(random, 132, 178);

    summaries.push(
      {
        date,
        category: "activity",
        totalSteps: steps,
        totalCalories: randomInteger(random, 1_900, 2_700),
        activeCalories,
        activeMinutes,
        totalDistance: Math.round(steps * randomBetween(random, 0.68, 0.82)),
        floorsClimbed: randomInteger(random, 3, 18),
        avgHeartRate,
        maxHeartRate,
        minHeartRate: restingHeartRate - randomInteger(random, 1, 4),
      },
      {
        date,
        category: "sleep",
        sleepDurationMinutes: totalSleepMinutes,
        sleepEfficiency: Math.round((totalSleepMinutes / timeInBedMinutes) * 100),
        deepSleepMinutes: deepMinutes,
        remSleepMinutes: remMinutes,
        lightSleepMinutes: lightMinutes,
        awakeDuringMinutes: awakeMinutes,
        timeInBedMinutes,
      },
      {
        date,
        category: "recovery",
        hrvAvg: hrv,
        hrvRmssd: hrv,
        restingHeartRate,
        recoveryScore,
        avgStressLevel: stress,
        bodyBattery,
        spo2Avg: spo2,
      },
    );

    const sleepEvent: SyntheticEvent = {
      category: "sleep",
      type: "night_sleep",
      sourceName,
      durationSeconds: totalSleepMinutes * 60,
      startDatetime: sleepStart,
      endDatetime: sleepEnd,
      externalId: `${externalPrefix}:${date}:sleep`,
      heartRateAvg: restingHeartRate + randomInteger(random, 2, 6),
      heartRateMin: restingHeartRate - randomInteger(random, 3, 7),
      sleepTotalDurationMinutes: totalSleepMinutes,
      sleepTimeInBedMinutes: timeInBedMinutes,
      sleepEfficiencyScore: Math.round((totalSleepMinutes / timeInBedMinutes) * 100),
      sleepDeepMinutes: deepMinutes,
      sleepRemMinutes: remMinutes,
      sleepLightMinutes: lightMinutes,
      sleepAwakeMinutes: awakeMinutes,
      isNap: false,
      sleepStages: buildSleepStages({
        startTime: sleepStart,
        totalMinutes: totalSleepMinutes,
        deepMinutes,
        remMinutes,
        awakeMinutes,
      }),
    };
    if ((sleepEvent.endDatetime ?? sleepEvent.startDatetime) <= asOf) {
      events.push(sleepEvent);
    }

    const workoutFrequency = dailyProfile === "active" ? 2 : dailyProfile === "recovery" ? 3 : 5;
    if (dayOrdinal % workoutFrequency === 0) {
      const workoutTypes = ["running", "strength_training", "cycling"] as const;
      const workoutType = workoutTypes[dayOrdinal % workoutTypes.length];
      const workoutStart = zonedDateTimeToTimestamp(
        date,
        args.timezone,
        dayOrdinal % 2 ? 7 : 18,
        20,
      );
      const durationMinutes = randomInteger(random, 35, 75);
      const distance =
        workoutType === "running"
          ? randomInteger(random, 4_500, 11_000)
          : workoutType === "cycling"
            ? randomInteger(random, 16_000, 45_000)
            : undefined;
      const heartRateMin = randomInteger(random, 82, 102);
      const heartRateMax = randomInteger(random, 145, 182);
      const workoutEvent: SyntheticEvent = {
        category: "workout",
        type: workoutType,
        sourceName,
        durationSeconds: durationMinutes * 60,
        startDatetime: workoutStart,
        endDatetime: workoutStart + durationMinutes * 60_000,
        externalId: `${externalPrefix}:${date}:workout`,
        heartRateMin,
        heartRateMax,
        heartRateAvg: randomInteger(random, heartRateMin, heartRateMax),
        energyBurned: randomInteger(random, 280, 780),
        distance,
        stepsCount: workoutType === "running" ? randomInteger(random, 5_500, 12_000) : undefined,
        movingTimeSeconds: Math.max(durationMinutes - 3, 1) * 60,
        totalElevationGain:
          workoutType === "strength_training" ? undefined : randomInteger(random, 30, 290),
      };
      if ((workoutEvent.endDatetime ?? workoutEvent.startDatetime) <= asOf) {
        events.push(workoutEvent);
      }
    }

    for (let hour = 7; hour <= 22; hour += 1) {
      const recordedAt = zonedDateTimeToTimestamp(date, args.timezone, hour);
      const daytimeCurve = Math.sin(((hour - 7) / 15) * Math.PI);
      if (recordedAt <= asOf) {
        points.push({
          seriesType: "heart_rate",
          recordedAt,
          value: Math.round(
            restingHeartRate + 8 + daytimeCurve * 18 + randomBetween(random, -5, 8),
          ),
          externalId: `${externalPrefix}:${date}:heart_rate:${hour}`,
        });
      }
      if (hour >= 8 && hour <= 20) {
        if (recordedAt <= asOf) {
          points.push({
            seriesType: "steps",
            recordedAt,
            value: Math.max(0, Math.round(steps / 13 + randomBetween(random, -150, 180))),
            externalId: `${externalPrefix}:${date}:steps:${hour}`,
          });
        }
      }
    }

    const morning = zonedDateTimeToTimestamp(date, args.timezone, 7, 15);
    const morningMetrics = [
      ["resting_heart_rate", restingHeartRate],
      ["heart_rate_variability_rmssd", hrv],
      ["oxygen_saturation", spo2],
      ["recovery_score", recoveryScore],
    ] as const;
    if (morning <= asOf) {
      for (const [seriesType, value] of morningMetrics) {
        points.push({
          seriesType,
          recordedAt: morning,
          value,
          externalId: `${externalPrefix}:${date}:${seriesType}`,
        });
      }
    }
  });

  return { dates, events, points, summaries };
}
