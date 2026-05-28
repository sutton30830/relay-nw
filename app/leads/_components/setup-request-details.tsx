import type { SetupRequestField } from "../_utils";

export function SetupRequestDetails({
  fields,
  compact = false,
}: {
  fields: SetupRequestField[];
  compact?: boolean;
}) {
  if (fields.length === 0) return null;

  return (
    <dl className={`setup-request ${compact ? "setup-request--compact" : ""}`}>
      {fields.map((field) => (
        <div className="setup-request__field" key={field.label}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
