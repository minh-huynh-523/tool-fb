-- FB Post Dashboard — sinh prompt ảnh + prompt video từ caption bài đối thủ (Gemini)
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
-- Trước đây: copy caption đối thủ -> dán tay vào Gemini kèm mega-prompt -> tự tách 2 phần.
-- Giờ: bấm nút trong app -> 1 lần gọi Gemini -> app tách sẵn thành prompt ảnh / prompt video.
-- RLS default-deny như các bảng khác (chỉ service_role đọc/ghi).

-- =========================================================
-- 1) competitor_post — thêm cột chứa output Gemini đã tách
-- =========================================================
alter table competitor_post
  add column if not exists story_analysis text,   -- mục ### STORY ANALYSIS (tham khảo)
  add column if not exists prompt_image   text,   -- mục ### IMAGE PROMPT
  add column if not exists prompt_video   text,   -- mục ### VIDEO PROMPT
  add column if not exists prompt_raw     text,   -- nguyên văn Gemini trả về — fallback khi tách hỏng
  add column if not exists prompt_model   text,   -- model đã dùng, để đối chiếu khi đổi model
  add column if not exists prompt_at      timestamptz,
  add column if not exists prompt_error   text;

create index if not exists competitor_post_prompt_idx
  on competitor_post (prompt_at desc nulls last);

-- =========================================================
-- 2) prompt_template — mega-prompt gửi Gemini, SỬA ĐƯỢC TRONG APP
--    (không hardcode -> tinh chỉnh câu chữ không cần deploy lại)
-- =========================================================
create table if not exists prompt_template (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null unique,   -- 'main' (hiện chỉ 1; để ngỏ nếu sau thêm loại khác)
  label      text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists prompt_template_touch on prompt_template;
create trigger prompt_template_touch
  before update on prompt_template
  for each row execute function touch_updated_at();

alter table prompt_template enable row level security;

-- Seed mega-prompt đang dùng. Dùng dollar-quote để khỏi phải escape dấu nháy.
-- QUAN TRỌNG: 3 heading trong "# OUTPUT FORMAT" (### STORY ANALYSIS / ### IMAGE PROMPT /
-- ### VIDEO PROMPT) là HỢP ĐỒNG mà splitPromptSections() trong lib/competitor-prompt.ts
-- dựa vào để tách output — sửa prompt thì giữ nguyên 3 heading này.
insert into prompt_template (kind, label, body) values
  ('main', 'Mega-prompt ảnh + video', $prompt$# ULTIMATE FACEBOOK VIRAL STORY → IMAGE + VIDEO PROMPT

When I send you a story, article, drama script, family conflict story, betrayal story, workplace conflict story, wedding drama story, HOA story, lawsuit story, emotional story, or any narrative content, perform the following tasks.

==================================================

# OBJECTIVE

Create content optimized for:

* Facebook Reels
* Facebook Video
* TikTok
* YouTube Shorts

Goal:

Make viewers stop scrolling within the first second and feel compelled to watch and comment.

==================================================

# STEP 1 – STORY ANALYSIS

Analyze the story and identify:

* Main character
* Opposing character
* Supporting characters
* Relationship between characters
* Story setting
* Highest emotional peak
* Most controversial moment
* Most shocking revelation
* Most viral dialogue
* Strongest emotional confrontation

Then create:

1. IMAGE PROMPT
2. VIDEO PROMPT

==================================================

# CHARACTER RULES

Convert all characters into:

American or Western characters.

Requirements:

* Attractive but realistic.
* Hollywood-quality appearance.
* Original fictional characters.
* Unique faces.
* Realistic skin texture.
* Natural imperfections.
* Realistic hair.
* Realistic clothing.
* Emotional eyes.
* Emotionally expressive faces.

Must avoid:

* Celebrity likeness.
* Actor likeness.
* Public figure resemblance.
* Copyrighted characters.
* TV character resemblance.
* Movie character resemblance.

Characters should feel like:

Unknown actors from a Netflix drama.

==================================================

# IMAGE PROMPT

Goal:

Create the most emotionally powerful thumbnail from the highest emotional peak of the story.

Requirements:

* 9:16 aspect ratio
* No text
* No logo
* No watermark
* Ultra realistic
* Photorealistic
* Hollywood cinematic photography
* Real-world photography
* 8K quality
* High detail

==================================================

# THUMBNAIL COMPOSITION

Highest priority:

Use TWO main characters.

The image must show:

* Face-to-face confrontation.
* Direct eye contact.
* Emotional tension.
* Active conflict.

Viewer must instantly think:

"What happened?"

"What secret was revealed?"

"Why are they fighting?"

"What is she about to say?"

==================================================

# CHARACTER DISTANCE

Maintain realistic conversational distance.

Approximately:

0.8–2 meters apart.

Do NOT create:

* Romantic pose.
* Intimate pose.
* Couple pose.
* Hugging.
* Kiss pose.
* Faces too close together.

Must feel like:

A confrontation scene.

Not a love scene.

==================================================

# FACIAL EXPRESSIONS

Eyes must tell the story.

Use:

* Betrayal.
* Anger.
* Shock.
* Disappointment.
* Fear.
* Sadness.
* Emotional conflict.

Expressions must feel:

Authentic.
Human.
Natural.

==================================================

# ENVIRONMENT

The environment must look completely real.

Not AI.

Not CGI.

Not studio.

Must look like:

* A real Netflix drama scene.
* A real HBO scene.
* A real television drama frame.

Environment should match the story naturally.

==================================================

# COLOR STYLE

Very important:

Use realistic cinematic color grading.

Requirements:

* Slightly muted colors.
* Slightly desaturated tones.
* Natural skin colors.
* Soft cinematic contrast.
* Realistic lighting.

Avoid:

* Oversaturated colors.
* Neon colors.
* HDR look.
* AI-generated color style.

The image should feel like:

A frame captured from a real TV drama.

==================================================

# IMAGE CAMERA STYLE

* Medium shot.
* Medium close-up.
* Two-shot composition.
* Professional cinema lens.
* Natural depth of field.
* Authentic television cinematography.

==================================================

# VIDEO PROMPT

Use the generated image as the reference image.

Create a 8-second cinematic video.

==================================================

# MOST IMPORTANT VIDEO RULE

Characters MUST talk to each other.

NOT TO THE CAMERA.

NOT TO THE AUDIENCE.

NOT MONOLOGUE.

The conversation must feel real.

The audience should feel they are secretly watching a real confrontation.

==================================================

# VIDEO INTERACTION

Throughout the entire 8 seconds:

* Direct eye contact between characters.
* Natural emotional reactions.
* Real conversation.
* Natural interruptions.
* Emotional tension.

The scene should feel like:

A dramatic scene from a television show.

==================================================

# VIDEO CHARACTER DISTANCE

Maintain realistic conversational spacing.

Do not:

* Move faces too close.
* Create romantic chemistry.
* Create intimacy.

Maintain:

* Emotional confrontation.
* Family conflict.
* Workplace conflict.
* Betrayal reveal.

==================================================

# BODY LANGUAGE

Use:

* Natural blinking.
* Realistic breathing.
* Eye movement.
* Small head movement.
* Realistic posture shifts.
* Emotional reactions.
* Subtle hand gestures.

==================================================

# DIALOGUE CREATION

Choose the strongest controversial hook from the story.

Rewrite it into:

Natural American English.

Requirements:

* Maximum 2 lines.
* Short.
* Emotional.
* Shocking.
* Comment-inducing.
* Viral.

Dialogue must be exchanged between characters.

Never create a monologue.

==================================================

# VIDEO CAMERA STYLE

Use:

* Over-the-shoulder shots.
* Shot-reverse-shot.
* Medium shots.
* Medium close-ups.
* Reaction shots.
* Slow cinematic push-in.
* Natural handheld camera movement.

Must look like:

Netflix drama.
HBO drama.
Hollywood television drama.

==================================================

# REALISM REQUIREMENTS

Must look like real actors.

Must look like a real location.

Must look like a real conversation.

Must look like a real television drama.

Must not look AI-generated.

Must not look CGI.

Must not look animated.

Must not look like social media acting.

==================================================

# NEGATIVE PROMPT

AI generated look, CGI, cartoon, anime, illustration, digital painting, 3D render, fake skin, plastic face, oversaturated colors, neon colors, extreme HDR, unrealistic lighting, duplicate people, extra fingers, distorted anatomy, watermark, logo, text, subtitles, looking at camera, talking head, vlog style, interview style, influencer style, romantic pose, kiss pose, hugging pose, couple pose, faces too close together, celebrity likeness, actor likeness, copyrighted character resemblance

==================================================

# OUTPUT FORMAT

### STORY ANALYSIS

[Detailed analysis]

### IMAGE PROMPT

[Complete image prompt]

### VIDEO PROMPT

Scene Description:
[...]

Character Dialogue:
[...]

Camera Movement:
[...]

Visual Style:
[...]

Sound Design:
[...]

Negative Prompt:
[...]
$prompt$)
on conflict (kind) do nothing;
