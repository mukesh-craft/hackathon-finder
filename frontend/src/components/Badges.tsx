import type { Hackathon } from '@hf/shared';

export function StatusBadge({ status }: { status: Hackathon['registrationStatus'] }) {
  const labels: Record<Hackathon['registrationStatus'], string> = {
    open: 'Registration open',
    upcoming: 'Opening soon',
    closed: 'Registration closed',
    unknown: 'Status unknown',
  };
  return (
    <span className={`badge badge-status-${status}`} role="status">
      {labels[status]}
    </span>
  );
}

export function QualityBadge({ quality }: { quality: Hackathon['dataQuality'] }) {
  const labels: Record<Hackathon['dataQuality'], string> = {
    verified: 'Verified deadline',
    source_confirmed: 'Source confirmed',
    partially_verified: 'Partially verified',
    unknown: 'Unverified',
  };
  const hints: Record<Hackathon['dataQuality'], string> = {
    verified: 'The registration deadline was published as a structured field by the event platform.',
    source_confirmed: 'The registration deadline was published by the source.',
    partially_verified: 'Some details are inferred or incomplete. Verify on the official page.',
    unknown: 'The source publishes no registration deadline.',
  };
  return (
    <span className={`badge badge-quality-${quality}`} title={hints[quality]}>
      {labels[quality]}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: Hackathon['onlineOrOffline'] }) {
  const labels: Record<string, string> = {
    online: 'Online',
    offline: 'Offline',
    hybrid: 'Hybrid',
    unknown: 'Format not stated',
  };
  return <span className={`badge badge-mode-${mode}`}>{labels[mode] ?? mode}</span>;
}

export function CountdownPill({
  label,
  urgency,
  expired,
}: {
  label: string;
  urgency: 'none' | 'critical' | 'soon' | 'comfortable' | 'unknown';
  expired: boolean;
}) {
  return (
    <span className={`countdown countdown-${urgency}${expired ? ' is-expired' : ''}`} aria-live="off">
      <span aria-hidden="true">⏳ </span>
      {label}
    </span>
  );
}
