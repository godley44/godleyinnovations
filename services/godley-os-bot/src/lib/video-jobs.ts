// The video_jobs ledger (migration 008) — the poller step that turns an
// APPROVED 'video.script' proposal into a finished video and files it as a
// social.post proposal. Claim-before-run, one job per script ever
// (unique(script_proposal_id)); every stage transition is persisted so a
// bot restart resumes from the last completed stage; terminal rows
// ('failed' with the reason, 'dry-run') are re-armed by deleting them.
//
//   scripted   — claimed. Next: resolve the venture's cloned voice, ElevenLabs
//                narration, upload to the public media bucket.
//   narrated   — audio_url set. Next: Pictory storyboard with that audio as
//                the external voiceover (script text drives captions).
//   assembling — Pictory is working (storyboard, then render). Polled once per
//                cycle: storyboard done → render submitted; render done →
//                MP4 downloaded and re-hosted in our Storage.
//   assembled  — video_url set. Next: content_calendar row (kind='video') +
//                the social.post proposal WITH a preview link, on the
//                existing rails. Publishing still needs that approval.
//   proposed   — done; the publish step owns it from here.
//   failed     — terminal, reason in `error`. Delete the row to re-run once
//                the cause is fixed (a re-run spends the minutes again).
//   dry-run    — terminal; VIDEO_DRY_RUN=1 logged what would be spent and
//                spent nothing.
//
// Money is spent at exactly two transitions (scripted→narrated: ElevenLabs
// characters; narrated→assembling: Pictory minutes), both only after the
// owner approved the script, both at most once per job.

import { listClonedVoices, synthesizeSpeech } from "../integrations/elevenlabs.js";
import { createStoryboard, downloadRendered, getJob, renderFromPreview } from "../integrations/pictory.js";
import { MEDIA_BUCKET, uploadPublicMedia } from "./media-storage.js";
import { tableErrorMessage } from "./report-poller.js";
import { socialProposalRow } from "./social-draft.js";
import { getSupabase } from "./supabase.js";
import { readVideoScriptPayload, type VideoScriptPayload } from "./video-script.js";

const MIGRATION_008 = "008_video_pipeline.sql";
const UNIQUE_VIOLATION = "23505";
const POLL_LIMIT = 10;
// A render that has been 'assembling' this long is stuck — Pictory quotes
// 2–10 minutes for a typical render.
const ASSEMBLING_TIMEOUT_MS = 45 * 60 * 1000;
// Blotato's documented ceiling for Instagram video (300 MB) is the lower of
// the two targets; a bigger file could never publish everywhere it is meant to.
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

export type VideoStage = "scripted" | "narrated" | "assembling" | "assembled" | "proposed" | "failed" | "dry-run";

export type VideoStatus =
  | "narrated" // narration produced this cycle
  | "assembling" // Pictory working (submitted or still rendering)
  | "assembled" // final video hosted this cycle
  | "proposed" // social.post proposal filed (this cycle or earlier)
  | "dry-run"
  | "failed" // recorded as failed this cycle (reason in detail)
  | "previously-failed"
  | "claim-conflict";

export interface VideoCandidate {
  jobId?: string;
  scriptProposalId: string;
  ventureSlug: string;
  ventureName: string;
  title: string;
  stage: VideoStage | null;
  status: VideoStatus;
  videoUrl?: string;
  detail?: string;
}

interface VideoJobRow {
  id: string;
  venture_id: string;
  script_proposal_id: string;
  stage: VideoStage;
  audio_url: string | null;
  pictory_storyboard_job: string | null;
  pictory_render_job: string | null;
  video_url: string | null;
  video_seconds: number | null;
  calendar_id: string | null;
  error: string | null;
  updated_at: string;
}

interface ApprovedScript {
  id: string;
  venture_id: string;
  payload: VideoScriptPayload;
  venture: { name: string; slug: string; elevenlabs_voice_id: string | null };
}

const STAGES: readonly string[] = ["scripted", "narrated", "assembling", "assembled", "proposed", "failed", "dry-run"];

function normalizeJob(raw: unknown): VideoJobRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.script_proposal_id !== "string" || typeof r.venture_id !== "string") return null;
  if (typeof r.stage !== "string" || !STAGES.includes(r.stage)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: r.id,
    venture_id: r.venture_id,
    script_proposal_id: r.script_proposal_id,
    stage: r.stage as VideoStage,
    audio_url: str(r.audio_url),
    pictory_storyboard_job: str(r.pictory_storyboard_job),
    pictory_render_job: str(r.pictory_render_job),
    video_url: str(r.video_url),
    video_seconds: typeof r.video_seconds === "number" ? r.video_seconds : r.video_seconds === null ? null : Number(r.video_seconds),
    calendar_id: str(r.calendar_id),
    error: str(r.error),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : new Date(0).toISOString(),
  };
}

export function isVideoDryRun(): boolean {
  return process.env.VIDEO_DRY_RUN === "1";
}

// Persist a stage transition. Stage moves are the ledger's whole point, so a
// failure to record one is loud and stops the job for this cycle.
async function setStage(jobId: string, patch: Partial<Omit<VideoJobRow, "id">> & { stage: VideoStage }): Promise<void> {
  const { error } = await getSupabase()
    .from("video_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`recording video_jobs stage '${patch.stage}' for ${jobId} failed: ${error.message}`);
}

class StageFailure extends Error {}

// Resolve the venture's cloned voice: the ventures row, or — exactly once —
// the account's single cloned voice, recorded back onto the venture so the
// choice is visible in the OS. Two clones is a configuration decision the
// owner makes (SQL: update ventures set elevenlabs_voice_id = …).
async function resolveVoiceId(script: ApprovedScript): Promise<string> {
  if (script.venture.elevenlabs_voice_id) return script.venture.elevenlabs_voice_id;
  const clones = await listClonedVoices();
  if (clones.length === 0) {
    throw new StageFailure("no cloned voice in the ElevenLabs account yet — clone the owner's voice there, then delete this video_jobs row");
  }
  if (clones.length > 1) {
    throw new StageFailure(
      `the ElevenLabs account has ${clones.length} cloned voices (${clones.map((c) => c.name).join(", ")}) — set ` +
        `ventures.elevenlabs_voice_id for ${script.venture.slug} to the right voice_id, then delete this video_jobs row`,
    );
  }
  const voice = clones[0]!;
  const { error } = await getSupabase().from("ventures").update({ elevenlabs_voice_id: voice.voiceId }).eq("id", script.venture_id);
  if (error) throw new Error(`recording the resolved voice on the venture failed: ${error.message}`);
  console.log(`[video] ${script.venture.slug}: using the account's only cloned voice "${voice.name}"`);
  return voice.voiceId;
}

async function narrate(job: VideoJobRow, script: ApprovedScript): Promise<VideoJobRow> {
  const voiceId = await resolveVoiceId(script);
  const audio = await synthesizeSpeech({ voiceId, text: script.payload.script });
  const uploaded = await uploadPublicMedia(`video/${job.id}/narration.mp3`, audio.bytes, audio.contentType);
  await setStage(job.id, { stage: "narrated", audio_url: uploaded.publicUrl });
  return { ...job, stage: "narrated", audio_url: uploaded.publicUrl };
}

async function submitStoryboard(job: VideoJobRow, script: ApprovedScript): Promise<VideoJobRow> {
  if (!job.audio_url) throw new StageFailure("job is 'narrated' but has no audio_url — delete the row to re-run");
  const storyboardJob = await createStoryboard({
    videoName: script.payload.title,
    script: script.payload.script,
    narrationUrl: job.audio_url,
  });
  await setStage(job.id, { stage: "assembling", pictory_storyboard_job: storyboardJob });
  return { ...job, stage: "assembling", pictory_storyboard_job: storyboardJob };
}

// One poll of Pictory. Returns the job (possibly advanced) and whether it is
// still waiting on Pictory.
async function pollAssembly(job: VideoJobRow): Promise<{ job: VideoJobRow; waiting: boolean; detail?: string }> {
  if (Date.now() - Date.parse(job.updated_at) > ASSEMBLING_TIMEOUT_MS) {
    throw new StageFailure(`Pictory has been assembling for over ${ASSEMBLING_TIMEOUT_MS / 60000} minutes — treated as stuck`);
  }
  if (!job.pictory_render_job) {
    if (!job.pictory_storyboard_job) throw new StageFailure("job is 'assembling' without a Pictory storyboard job id — delete the row to re-run");
    const sb = await getJob(job.pictory_storyboard_job);
    if (sb.status === "failed") throw new StageFailure(`Pictory storyboard failed: ${sb.error}`);
    if (sb.status === "in-progress") return { job, waiting: true, detail: "Pictory is building the storyboard" };
    const renderJob = await renderFromPreview(job.pictory_storyboard_job);
    await setStage(job.id, { stage: "assembling", pictory_render_job: renderJob });
    return { job: { ...job, pictory_render_job: renderJob }, waiting: true, detail: "Pictory is rendering" };
  }
  const render = await getJob(job.pictory_render_job);
  if (render.status === "failed") throw new StageFailure(`Pictory render failed: ${render.error}`);
  if (render.status === "in-progress") {
    return { job, waiting: true, detail: `Pictory is rendering${render.progress !== null ? ` (${render.progress}%)` : ""}` };
  }
  if (!render.videoUrl) throw new StageFailure("Pictory reported the render complete without a video URL");
  const video = await downloadRendered(render.videoUrl);
  if (video.bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new StageFailure(`the rendered video is ${Math.round(video.bytes.byteLength / 1048576)} MB — over Blotato's 300 MB Instagram ceiling`);
  }
  const uploaded = await uploadPublicMedia(`video/${job.id}/video.mp4`, video.bytes, video.contentType);
  await setStage(job.id, { stage: "assembled", video_url: uploaded.publicUrl, video_seconds: render.videoSeconds });
  return { job: { ...job, stage: "assembled", video_url: uploaded.publicUrl, video_seconds: render.videoSeconds }, waiting: false };
}

// The hand-off to the existing rails: a kind='video' calendar row and its
// social.post proposal carrying the preview link. Sub-steps are persisted
// (calendar_id on the job first) so a crash between them never files a
// second calendar row.
async function propose(job: VideoJobRow, script: ApprovedScript): Promise<VideoJobRow> {
  if (!job.video_url) throw new StageFailure("job is 'assembled' but has no video_url — delete the row to re-run");
  const supabase = getSupabase();
  let calendarId = job.calendar_id;
  if (!calendarId) {
    const { data, error } = await supabase
      .from("content_calendar")
      .insert({
        venture_id: script.venture_id,
        kind: "video",
        title: script.payload.title,
        body: script.payload.script,
        media_urls: [job.video_url],
        platforms: script.payload.platforms,
        status: "draft",
        source_proposal_id: script.id,
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(tableErrorMessage(error?.message ?? "no row returned", error?.code, "content_calendar", MIGRATION_008));
    }
    calendarId = (data as { id: string }).id;
    await setStage(job.id, { stage: "assembled", calendar_id: calendarId });
  }

  const { data: propRow, error: propError } = await supabase
    .from("proposals")
    .insert(
      socialProposalRow({
        ventureId: script.venture_id,
        calendarId,
        text: script.payload.script,
        platforms: script.payload.platforms,
        proposedBy: "video-agent",
        video: { title: script.payload.title, previewUrl: job.video_url },
      }),
    )
    .select("id")
    .single();
  if (propError || !propRow) throw new Error(`filing the video's social.post proposal failed: ${propError?.message ?? "no row returned"}`);
  const proposalId = (propRow as { id: string }).id;

  const { error: wireError } = await supabase
    .from("content_calendar")
    .update({ status: "proposed", proposal_id: proposalId, updated_at: new Date().toISOString() })
    .eq("id", calendarId)
    .eq("status", "draft");
  if (wireError) {
    throw new Error(
      `proposal ${proposalId} was filed but wiring it to calendar row ${calendarId} failed: ${wireError.message} — ` +
        "reject that proposal, then delete this video_jobs row to re-file",
    );
  }
  await setStage(job.id, { stage: "proposed", calendar_id: calendarId });
  return { ...job, stage: "proposed", calendar_id: calendarId };
}

async function recordFailure(jobId: string, reason: string): Promise<void> {
  const { error } = await getSupabase()
    .from("video_jobs")
    .update({ stage: "failed", error: reason, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) console.error(`[video] CRITICAL: could not record the failure of job ${jobId} (${error.message}); its row keeps its last stage`);
}

async function loadApprovedScripts(): Promise<ApprovedScript[]> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, venture_id, payload, venture:ventures(name, slug, elevenlabs_voice_id)")
    .eq("action", "video.script")
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(POLL_LIMIT);
  // A database without migration 008 has no video.script rows and this
  // filter still succeeds (the CHECK constraint is not consulted on reads).
  if (error) throw new Error(`proposals query failed: ${error.message}`);
  return (data ?? []).flatMap((raw): ApprovedScript[] => {
    const r = raw as Record<string, unknown>;
    const payload = readVideoScriptPayload(r.payload);
    const v = (Array.isArray(r.venture) ? r.venture[0] : r.venture) as Record<string, unknown> | null | undefined;
    if (typeof r.id !== "string" || typeof r.venture_id !== "string" || !payload || !v) return [];
    if (typeof v.name !== "string" || typeof v.slug !== "string") return [];
    return [
      {
        id: r.id,
        venture_id: r.venture_id,
        payload,
        venture: { name: v.name, slug: v.slug, elevenlabs_voice_id: typeof v.elevenlabs_voice_id === "string" ? v.elevenlabs_voice_id : null },
      },
    ];
  });
}

export async function runVideoStep(): Promise<VideoCandidate[]> {
  const scripts = await loadApprovedScripts();
  if (scripts.length === 0) return [];
  const supabase = getSupabase();

  const { data: jobData, error: jobError } = await supabase
    .from("video_jobs")
    .select("id, venture_id, script_proposal_id, stage, audio_url, pictory_storyboard_job, pictory_render_job, video_url, video_seconds, calendar_id, error, updated_at")
    .in(
      "script_proposal_id",
      scripts.map((s) => s.id),
    );
  if (jobError) throw new Error(tableErrorMessage(jobError.message, jobError.code, "video_jobs", MIGRATION_008));
  const jobs = new Map<string, VideoJobRow>();
  for (const raw of jobData ?? []) {
    const j = normalizeJob(raw);
    if (j) jobs.set(j.script_proposal_id, j);
  }

  const dryRun = isVideoDryRun();
  const candidates: VideoCandidate[] = [];
  for (const script of scripts) {
    const candidate: VideoCandidate = {
      scriptProposalId: script.id,
      ventureSlug: script.venture.slug,
      ventureName: script.venture.name,
      title: script.payload.title,
      stage: null,
      status: "proposed",
    };

    let job = jobs.get(script.id) ?? null;
    if (!job) {
      // CLAIM before spending anything — same protocol as every other ledger.
      const { data, error } = await supabase
        .from("video_jobs")
        .insert({ venture_id: script.venture_id, script_proposal_id: script.id, stage: "scripted" })
        .select("id, venture_id, script_proposal_id, stage, audio_url, pictory_storyboard_job, pictory_render_job, video_url, video_seconds, calendar_id, error, updated_at")
        .single();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          candidate.status = "claim-conflict";
          candidate.detail = "another writer claimed this script between read and claim — not running";
          console.error(`[video] claim conflict on script ${script.id} (${script.venture.slug}) — skipped`);
          candidates.push(candidate);
          continue;
        }
        throw new Error(tableErrorMessage(error.message, error.code, "video_jobs", MIGRATION_008));
      }
      job = normalizeJob(data);
      if (!job) throw new Error("video_jobs claim returned an unreadable row");
      console.log(`[video] claimed script ${script.id} (${script.venture.slug}) as job ${job.id}`);
    }
    candidate.jobId = job.id;
    candidate.stage = job.stage;

    if (job.stage === "failed") {
      candidate.status = "previously-failed";
      candidate.detail = job.error ?? "no reason recorded";
      candidates.push(candidate);
      continue;
    }
    if (job.stage === "dry-run") {
      candidate.status = "dry-run";
      candidate.detail = "dry run recorded — delete this video_jobs row to run for real";
      candidates.push(candidate);
      continue;
    }
    if (job.stage === "proposed") {
      candidate.status = "proposed";
      candidate.videoUrl = job.video_url ?? undefined;
      candidates.push(candidate);
      continue;
    }

    try {
      if (job.stage === "scripted" && dryRun) {
        console.log(
          `[video] DRY RUN — job ${job.id} (${script.venture.slug}) would narrate ${script.payload.script.length} chars with ElevenLabs, ` +
            `upload to ${MEDIA_BUCKET}/video/${job.id}/narration.mp3, and submit a Pictory 9:16 storyboard titled "${script.payload.title}"`,
        );
        await setStage(job.id, { stage: "dry-run" });
        candidate.stage = "dry-run";
        candidate.status = "dry-run";
        candidate.detail = "request logged, nothing spent (VIDEO_DRY_RUN=1)";
        candidates.push(candidate);
        continue;
      }
      if (job.stage === "scripted") {
        job = await narrate(job, script);
        candidate.status = "narrated";
        console.log(`[video] job ${job.id} narrated (${script.venture.slug})`);
      }
      if (job.stage === "narrated") {
        job = await submitStoryboard(job, script);
        candidate.status = "assembling";
        candidate.detail = "storyboard submitted to Pictory";
        candidate.stage = job.stage;
        candidates.push(candidate);
        continue;
      }
      if (job.stage === "assembling") {
        const polled = await pollAssembly(job);
        job = polled.job;
        if (polled.waiting) {
          candidate.status = "assembling";
          candidate.detail = polled.detail;
          candidate.stage = job.stage;
          candidates.push(candidate);
          continue;
        }
        candidate.status = "assembled";
        console.log(`[video] job ${job.id} assembled (${script.venture.slug}): ${job.video_url}`);
      }
      if (job.stage === "assembled") {
        job = await propose(job, script);
        candidate.status = "proposed";
        candidate.videoUrl = job.video_url ?? undefined;
        candidate.detail = "social.post proposal filed with the preview link — approve it to publish";
        console.log(`[video] job ${job.id} proposed as calendar row ${job.calendar_id} (${script.venture.slug})`);
      }
      candidate.stage = job.stage;
    } catch (err) {
      // Terminal: fix the cause, delete the row, the next cycle re-runs
      // (and re-spends). A non-StageFailure error is just as terminal — a
      // half-done job must never silently retry and double-spend.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[video] JOB FAILED: ${job.id} (${script.venture.slug}) at stage ${job.stage}: ${reason}`);
      await recordFailure(job.id, reason);
      candidate.stage = "failed";
      candidate.status = "failed";
      candidate.detail = reason;
    }
    candidates.push(candidate);
  }
  return candidates;
}
