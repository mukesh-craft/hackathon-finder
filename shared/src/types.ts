/**
 * Normalized domain types shared by adapters, backend and frontend.
 *
 * Design rules encoded here (these are the product's correctness contract):
 *  - A field is either populated with evidence, or explicitly null. Never guessed.
 *  - Every populated field can be traced back to a source via `FieldProvenance`.
 *  - `precision` distinguishes a real instant from a bare calendar date, so the
 *    UI can render "time not specified" instead of inventing 23:59.
 */

export type SourceId = 'unstop' | 'devpost' | 'mlh' | 'hackerearth' | 'organizer_website';

export const SOURCE_IDS: SourceId[] = ['unstop', 'devpost', 'mlh', 'hackerearth', 'organizer_website'];

/** Higher number = more authoritative for conflict resolution. */
export const SOURCE_TRUST: Record<SourceId, number> = {
  organizer_website: 5,
  mlh: 4,
  unstop: 4,
  devpost: 4,
  hackerearth: 3,
};

export type DatePrecision = 'instant' | 'date_only' | 'none';

/** Semantic role of a date in an event's lifecycle. Never conflate these. */
export type DeadlineKind =
  | 'registration_opens'
  | 'registration_deadline'
  | 'application_deadline'
  | 'idea_submission_deadline'
  | 'submission_deadline'
  | 'project_submission_deadline'
  | 'shortlisting'
  | 'hackathon_start'
  | 'hackathon_end'
  | 'final_presentation'
  | 'result_announcement'
  | 'unknown';

export const DEADLINE_KINDS: DeadlineKind[] = [
  'registration_opens',
  'registration_deadline',
  'application_deadline',
  'idea_submission_deadline',
  'submission_deadline',
  'project_submission_deadline',
  'shortlisting',
  'hackathon_start',
  'hackathon_end',
  'final_presentation',
  'result_announcement',
  'unknown',
];

export const DEADLINE_KIND_LABELS: Record<DeadlineKind, string> = {
  registration_opens: 'Registration opens',
  registration_deadline: 'Registration closes',
  application_deadline: 'Application deadline',
  idea_submission_deadline: 'Idea submission deadline',
  submission_deadline: 'Submission deadline',
  project_submission_deadline: 'Project submission deadline',
  shortlisting: 'Shortlisting',
  hackathon_start: 'Hackathon starts',
  hackathon_end: 'Hackathon ends',
  final_presentation: 'Final presentation',
  result_announcement: 'Results announced',
  unknown: 'Unclassified date',
};

/** How a registration_deadline value came to exist. Surfaced verbatim in the UI. */
export type DeadlineBasis =
  | 'source_explicit'
  | 'inferred_from_submission_deadline'
  | 'inferred_from_event_end'
  | 'unknown';

export type Confidence = 'verified' | 'source_confirmed' | 'partially_verified' | 'inferred' | 'unknown';

export type DataQuality = 'verified' | 'source_confirmed' | 'partially_verified' | 'unknown';

export type RegistrationStatus = 'open' | 'closed' | 'upcoming' | 'unknown';

export type OnlineOrOffline = 'online' | 'offline' | 'hybrid' | 'unknown';

export type EventType = 'hackathon' | 'competition' | 'datathon' | 'ideathon' | 'unknown';

/**
 * A date we extracted, together with everything needed to justify it.
 * `iso` is an ISO-8601 string: full instant (`2026-09-29T23:59:00+05:30`) when the
 * source gave a time, or a bare date (`2026-09-29`) when it did not.
 */
export interface ExtractedDate {
  iso: string | null;
  kind: DeadlineKind;
  precision: DatePrecision;
  /** Timezone as written by the source, e.g. "IST", "PDT", "UTC+5:30". Null if absent. */
  sourceTimezone: string | null;
  /** UTC offset in minutes if the source stated or implied one. */
  offsetMinutes: number | null;
  /** Exact wording from the source, preserved verbatim. */
  raw: string;
  /** The label text that determined `kind`, e.g. "Registration Deadline". */
  label: string | null;
  confidence: Confidence;
}

export interface FieldProvenance {
  field: string;
  value: string | number | boolean | null;
  source: SourceId | 'merged';
  sourceUrl: string;
  retrievedAt: string;
  confidence: Confidence;
}

/** What a source adapter emits, before dedupe/merge. */
export interface RawHackathon {
  source: SourceId;
  /** Stable id within the source. */
  sourceRecordId: string;
  title: string;
  description?: string | null;
  organizer?: string | null;
  sourceUrl: string;
  registrationUrl?: string | null;
  locationText?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  venue?: string | null;
  eventType?: EventType;
  onlineOrOffline?: OnlineOrOffline;
  registrationOpensAt?: ExtractedDate | null;
  registrationDeadline?: ExtractedDate | null;
  hackathonStart?: ExtractedDate | null;
  hackathonEnd?: ExtractedDate | null;
  submissionDeadline?: ExtractedDate | null;
  ideaSubmissionDeadline?: ExtractedDate | null;
  finalPresentation?: ExtractedDate | null;
  resultAnnouncement?: ExtractedDate | null;
  teamSizeMin?: number | null;
  teamSizeMax?: number | null;
  eligibility?: string | null;
  themes?: string[];
  technologies?: string[];
  prizeAmount?: number | null;
  prizeCurrency?: string | null;
  prizeDetails?: string | null;
  registrationFee?: number | null;
  registrationFeeCurrency?: string | null;
  freeOrPaid?: 'free' | 'paid' | 'unknown';
  /** The verbatim deadline wording shown on the source page. */
  sourceDeadlineText?: string | null;
  /** Where each populated field came from. */
  provenance: FieldProvenance[];
  /** Raw payload retained for debugging and re-parsing. */
  raw?: unknown;
  /** Epoch ms the source was read. */
  retrievedAt: string;
}

/** The merged, user-facing record. Mirrors the `hackathons` table. */
export interface Hackathon {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  organizer: string | null;
  source: SourceId;
  sourceUrl: string;
  registrationUrl: string | null;
  locationText: string | null;
  cityId: string | null;
  city: string | null;
  cityCanonical: string | null;
  state: string | null;
  country: string | null;
  venue: string | null;
  latitude: number | null;
  longitude: number | null;
  eventType: EventType;
  onlineOrOffline: OnlineOrOffline;
  registrationOpensAt: string | null;
  registrationDeadline: string | null;
  registrationDeadlinePrecision: DatePrecision;
  registrationDeadlineTimezone: string | null;
  registrationDeadlineBasis: DeadlineBasis;
  registrationStatus: RegistrationStatus;
  hackathonStart: string | null;
  hackathonEnd: string | null;
  submissionDeadline: string | null;
  ideaSubmissionDeadline: string | null;
  finalPresentation: string | null;
  resultAnnouncement: string | null;
  teamSizeMin: number | null;
  teamSizeMax: number | null;
  eligibility: string | null;
  themes: string[];
  technologies: string[];
  prizeAmount: number | null;
  prizeCurrency: string | null;
  prizeDetails: string | null;
  freeOrPaid: 'free' | 'paid' | 'unknown';
  registrationFee: number | null;
  registrationFeeCurrency: string | null;
  dataQuality: DataQuality;
  deadlineConflict: boolean;
  deadlineConflictDetail: DeadlineConflict | null;
  sourceDeadlineText: string | null;
  lastVerifiedAt: string;
  nextVerificationAt: string | null;
  updatedAt: string;
  distanceKm: number | null;
  /** All sources that contributed to this merged record. */
  sources: HackathonSourceRef[];
  provenance: FieldProvenance[];
}

export interface HackathonSourceRef {
  source: SourceId;
  sourceRecordId: string;
  sourceUrl: string;
  registrationUrl: string | null;
  title: string;
  organizer: string | null;
  fetchedAt: string;
  fetchStatus: 'ok' | 'partial' | 'failed';
}

export interface DeadlineConflict {
  field: string;
  values: Array<{
    value: string;
    source: SourceId;
    sourceUrl: string;
    trust: number;
  }>;
  resolvedFrom: SourceId | null;
  resolutionNote: string;
}

export type SortOption =
  | 'relevance'
  | 'deadline'
  | 'event_date'
  | 'distance'
  | 'prize'
  | 'recently_updated';

export interface SearchQuery {
  city?: string;
  q?: string;
  openOnly?: boolean;
  radiusKm?: number | null;
  mode?: 'all' | 'online' | 'offline';
  freeOnly?: boolean;
  paidOnly?: boolean;
  prizeOnly?: boolean;
  teamSizeMax?: number | null;
  teamSizeMin?: number | null;
  themes?: string[];
  technologies?: string[];
  eligibility?: string[];
  eventFrom?: string | null;
  eventTo?: string | null;
  sort?: SortOption;
  page: number;
  limit: number;
  includeUnverified?: boolean;
}

export interface ResolvedCity {
  /** What the user typed. */
  query: string;
  /** Canonical city name we matched. */
  name: string | null;
  slug: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  /** How the query resolved. */
  match: 'exact' | 'alias' | 'metro' | 'state' | 'unknown';
  /** Human-readable explanation, e.g. "Bombay -> Mumbai". */
  notes: string[];
  /** Alternate names that also match this city. */
  aliases: string[];
  /** Nearby cities in the same metro area. */
  metroMembers: string[];
  geocodeSource: string | null;
}

export interface SearchResponse {
  city: ResolvedCity;
  count: number;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  results: Hackathon[];
  /**
   * Online events shown alongside a city search, so location-independent
   * hackathons are discoverable without polluting the physical ranking.
   * Present only when a city was searched and the format filter allows online.
   */
  online: { total: number; results: Hackathon[] } | null;
  facets: {
    themes: Array<{ value: string; count: number }>;
    technologies: Array<{ value: string; count: number }>;
    eligibility: Array<{ value: string; count: number }>;
    online: number;
    offline: number;
    withPrize: number;
    withDeadline: number;
    withConflict: number;
  };
  dataFreshness: {
    lastIngestAt: string | null;
    lastIngestSource: SourceId | null;
    sourcesWithData: SourceId[];
  };
  generatedAt: string;
  /** True while a visit-triggered background refresh is running. */
  refreshing: boolean;
}

export interface PipelineStats {
  totals: {
    hackathons: number;
    openRegistrations: number;
    closedRegistrations: number;
    unknownRegistration: number;
    deadlineConflicts: number;
    missingDeadlines: number;
    duplicateCandidates: number;
    updatedToday: number;
  };
  sources: Array<{
    source: SourceId;
    lastOkAt: string | null;
    lastErrorAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
    successCount: number;
    failureCount: number;
    avgDurationMs: number | null;
    records: number;
    health: 'healthy' | 'degraded' | 'failing' | 'unknown' | 'disabled';
  }>;
  lastCrawlAt: string | null;
  cityCount: number;
}
