import { requireAccountUserJson } from "@/lib/auth";
import { GREETING_BUCKET, removeGreetingFiles } from "@/lib/greeting-storage";
import { recordAccountAuditEvents, recordDataRetentionAction, supabaseAdmin, updateAccountSettings } from "@/lib/supabase";

export async function POST(request: Request) {
  const auth = await requireAccountUserJson();
  if (auth.response) return auth.response;
  if (auth.session.role === "viewer") return Response.json({ error: "View-only users cannot change the greeting" }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.type !== "audio/wav" || file.size < 100 || file.size > 8_000_000) {
    return Response.json({ error: "Record a greeting shorter than about two minutes" }, { status: 400 });
  }
  const bucket = GREETING_BUCKET;
  const existing = await supabaseAdmin.storage.getBucket(bucket);
  if (existing.error) {
    const created = await supabaseAdmin.storage.createBucket(bucket, {
      public: true,
      allowedMimeTypes: ["audio/wav"],
      fileSizeLimit: 8_000_000,
    });
    if (created.error && !/already exists/i.test(created.error.message)) {
      return Response.json({ error: "Greeting storage is unavailable" }, { status: 503 });
    }
  }
  const path = `${auth.session.accountId}/greeting-${Date.now()}.wav`;
  const upload = await supabaseAdmin.storage.from(bucket).upload(path, file, { contentType: "audio/wav", upsert: false });
  if (upload.error) return Response.json({ error: "Could not upload greeting" }, { status: 500 });
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  try {
    await updateAccountSettings(auth.session.accountId, {
      missed_call_greeting_audio_url: data.publicUrl,
      greeting_preference: "recorded",
    });
  } catch (error) {
    const rollback = await supabaseAdmin.storage.from(bucket).remove([path]);
    console.error("Greeting settings update failed after upload", {
      accountId: auth.session.accountId,
      uploadRollbackFailed: Boolean(rollback.error),
      error: error instanceof Error ? error.message : error,
    });
    return Response.json({ error: "Could not save greeting settings" }, { status: 500 });
  }
  const cleanup = await removeGreetingFiles(auth.session.accountId, path);
  await recordDataRetentionAction({
    accountId: auth.session.accountId,
    actorUserId: auth.session.userId,
    actorEmail: auth.session.email,
    action: "greeting.replaced_files_cleanup",
    status: cleanup.failed.length > 0 ? "failed" : "completed",
    counts: { deletedGreetingFiles: cleanup.deleted },
    failureKinds: cleanup.failed.length > 0 ? ["supabase_storage"] : [],
  });
  await recordAccountAuditEvents({
    accountId: auth.session.accountId,
    actorUserId: auth.session.userId,
    actorEmail: auth.session.email,
    events: [{
      action: "settings.greeting_recorded",
      summary: cleanup.failed.length > 0
        ? "Recorded a new voicemail greeting; old-file cleanup needs retry"
        : "Recorded a new voicemail greeting and removed replaced greeting files",
    }],
  });
  return Response.json({ url: data.publicUrl, cleanupPending: cleanup.failed.length > 0 }, {
    status: cleanup.failed.length > 0 ? 207 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
