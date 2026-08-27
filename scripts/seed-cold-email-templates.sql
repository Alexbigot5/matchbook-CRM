-- Seed: the 13 cold email templates from Matchbook_Cold_Email_Templates.docx.
--
-- NOT a numbered migration. Everything in migrations/ is schema, applied through
-- Wrangler's d1_migrations ledger; this is content, and content that someone will
-- edit on /templates the moment they read it. Mixing the two would mean a fresh
-- database replays copy that has since been rewritten in place. Apply it by hand:
--
--   npx wrangler d1 execute crm-db --local  --file=scripts/seed-cold-email-templates.sql
--   npx wrangler d1 execute crm-db --remote --file=scripts/seed-cold-email-templates.sql
--
-- The ids below are literal UUIDs rather than generated at apply time, which makes
-- a second run fail loudly on the email_templates primary key instead of quietly
-- seeding a duplicate set. That is the intended behaviour — re-running is a
-- mistake, not an upsert.
--
-- Decisions baked in, all of them reversible on /templates:
--   loop     = 1  — always-on outbound. Nothing here is event/blitz content.
--   send_day = 0  — these are 13 alternative FIRST TOUCHES across four ICPs, not
--                   sequential steps of one thread. buildSequencePlan() derives a
--                   sequence's order from ascending sendDay, so staggering them
--                   here would chain unrelated ICP copy into one nonsense drip.
--                   Ordering belongs to whoever builds a campaign on /smartlead.
--   status   = 'draft' — nothing is sendable until a human reviews it.
--   subject  = ''      — every version in the doc reads "(hold for later pass)".
--                   usableSlots in the /smartlead loader counts a variant on body
--                   content alone, so a blank subject does not block selection.
--
-- Slot A is is_default = 1 and slot B is 0, matching createTemplate/addVariant:
-- the incumbent keeps serving until someone promotes the challenger.
--
-- Micro CPG Resume/Credibility is two templates, not one. The doc carries Version
-- A, Version B and a Version B-alt, but the unique (template_id, slot) index caps
-- a template at two variants. B-alt is described in the doc as an A/B test against
-- Version B, i.e. a second challenger to the same incumbent, so it is seeded as
-- "(vs B-alt)" reusing Version A's copy verbatim rather than displacing it.


-- 1. Primary ICP: Resume/Credibility (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('a8106d65-ac7b-420b-a8ac-a2c8a3da211a', 'Primary ICP: Resume/Credibility', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('28c0e762-88b6-4ccf-8d5b-67e5d19f3d2c', 'a8106d65-ac7b-420b-a8ac-a2c8a3da211a', 'A', '', 'Hey [First Name],

we''re actively looking to work with growth-stage brands like yours after spending the last few years doing the bigger-brand thing (clients include Jack Link''s, Perplexity, Kalshi, Ridge, Bluechew, Samsung, LG, Netflix, Erewhon, and some others you''d recognize).

All the big brands are referencing growth-stage, nimble, agile brands in their board meetings and asking "why can''t we do this?" (Hint hint, it''s them and their 32 required sign-offs.)

You''re in the hybrid DTC/retail space where digital demand has to turn into in-store velocity, and that''s a specific gap we have a really consistent program for.

Between lowering CAC or getting more sales velocity, what''s the priority for you right now? Or is it both?

here to help,

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('7ff04527-e271-4f50-afd0-0903fd97e15d', 'a8106d65-ac7b-420b-a8ac-a2c8a3da211a', 'B', '', 'Hey [First Name],

we (Matchbook) have worked with companies like:

- Jack Link''s (AOR for over three years)
- Ridge Wallet
- Kalshi
- Erewhon
- Perplexity (did their 2025 Super Bowl campaign)
- and a handful of others you''d recognize

We''re looking to spend more time with growth-stage consumer brands, especially ones doing both DTC and retail, as our full-funnel programs work really well when scaled and customized to fit the space.

Between lowering CAC or getting more sales velocity, what''s the priority for you right now? Or is it both?

here to help,

Tom', 0);

-- 2. Primary ICP: Short & Clear (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('fcecbefb-0fda-471c-bae6-3acca4e126ff', 'Primary ICP: Short & Clear', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('e75c239e-b6d8-43d0-a17c-eb756de2c5b2', 'fcecbefb-0fda-471c-bae6-3acca4e126ff', 'A', '', 'Hey [First Name],

I know that you''re expanding your retail presence, and generally brands are at risk of hitting a wall right there (especially after a big PO) when the demand-gen plan doesn''t quite drive the in-store velocity needed to keep products moving.

We can help. We run a (incoming buzzwords alert) geo-fenced, digital-to-retail, influencer-led growth engine, and have done this for companies you''d recognize like Jack Link''s and Ridge Wallet, plus growth-stage brands similar to [Brand].

Let''s jam?

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('40070962-c5ad-492e-81c9-e4f8a932243c', 'fcecbefb-0fda-471c-bae6-3acca4e126ff', 'B', '', 'Hi [First Name],

we (Matchbook) know that [Brand] is around the [$X]M ARR mark (at least that''s what our AI tells us), and selling both in store and online. This often becomes a major pinch point for brands in terms of sustainably driving demand and sales velocity to both.

So we help consumer brands (like Jack Link''s, Ridge, and others) turn digital demand into retail velocity using a proprietary blend of herbs and spices, lol. (Read: a geo-fenced, digital-to-retail, influencer-led growth engine.)

Between lowering CAC or getting more velocity at retail, what''s the priority for you right now? Or is it both?

here to help,

Tom', 0);

-- 3. Primary ICP: Personal/Coworker (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('7a9ecb9b-2dca-4af6-87b4-208fb0a7a4b4', 'Primary ICP: Personal/Coworker', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('c3b4821e-3b1a-4d38-9650-fb9e52229a2e', '7a9ecb9b-2dca-4af6-87b4-208fb0a7a4b4', 'A', '', 'Hey [First Name], I''ll spare you the whole "hope this finds you well" thing lol, but I saw [Brand] next to my go-to [bigger, competing brand] on shelf at [retailer/store] and got curious. Are you running anything to convert the digital audience into people actually walking in and buying? That''s something we specialize in (did it for Jack Link''s, Ridge, beast brands, and more).

here to help,

Tom', 1);

-- 4. Consumer SaaS: Resume/Credibility (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('a9023eb8-4798-48d9-9364-1490f2e12d39', 'Consumer SaaS: Resume/Credibility', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('954c6f28-89d0-474e-a6eb-e8b1ff3e0033', 'a9023eb8-4798-48d9-9364-1490f2e12d39', 'A', '', 'Hey [First Name],

after spending the last few years working across both B2B and consumer SaaS (clients incl. ManyChat, ClickUp, Perplexity, and some others you''d recognize) we''re actively looking to work with more consumer SaaS brands like [Brand] because it seems to us like it''s crunch time for brand-building.

As you know, product alone isn''t going to hold as AI compresses feature moats to nothing, meaning (yes, we have a bias here) brand is the last thing left that''s actually defensible. We all know that VC operators who went heavily into consumer SaaS a few years back are openly worried about ROI on those bets, which a real brand building and distribution engine would help solve, and that''s a specific gap we have a really consistent program for.

Between expanding awareness or driving down-funnel conversion, what''s your priority right now? Or is it both?

here to help,

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('411fa1f9-347f-406b-b311-165e3b58d8c9', 'a9023eb8-4798-48d9-9364-1490f2e12d39', 'B', '', 'Hey [First Name],

we (Matchbook) have done brand building and demand-gen for SaaS brands (both B2B and consumer) like:

- ManyChat
- ClickUp
- Perplexity
- Others you''d recognize

We''re actively focusing on consumer SaaS right now because it''s crunch time for brand-building: VC operators we''ve been talking to who went heavy into consumer SaaS a few years ago are openly worried about ROI on those bets, and the pattern is always the same, great product, no real distribution engine, no brand to fall back on when the next AI-native version shows up.

If expanding awareness or driving down-funnel conversion are a priority for [Brand], we should talk!

here to help,

Tom', 0);

-- 5. Consumer SaaS: Personal/Coworker (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('59fb71e9-d51b-4d0e-b46e-294e2f3af746', 'Consumer SaaS: Personal/Coworker', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('ee672e89-d85a-4984-9817-4cfc8bb5850e', '59fb71e9-d51b-4d0e-b46e-294e2f3af746', 'A', '', 'Hey [First Name],

A friend of mine runs a consumer SaaS (solopreneur, doing about $50K/mo profit) and just told me he''s spending $5K a month on UGC now, because this whole category is going to look identical in six months, so brand awareness paired with a way to capture it are the only things that will matter. Made me look at [Brand] and wonder what you have in place in terms of brand building and demand gen.

Between building brand awareness or systematizing a way to capture it, which one is more urgent for you right now? (I''m assuming probably both?)

here to help,

Tom', 1);

-- 6. Consumer SaaS: Short & Clear (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('f59fc59b-aabb-4f57-a15b-ee065f201b9c', 'Consumer SaaS: Short & Clear', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('f06d2b73-64f7-4e6d-8524-e13c19cc7055', 'f59fc59b-aabb-4f57-a15b-ee065f201b9c', 'A', '', 'Hey [First Name],

Our AI scraper tells us that [Brand] is around the [$X]M ARR mark. So in a consumer SaaS category where the frontier models are constantly turning feature "moats" into their own native features, brand (obviously) goes from a nice-to-have to the actual thing keeping you in business. It''s the same thing the VC operators we talk to every day are flagging right now, because they went heavy into consumer SaaS a few years back and are openly worried about ROI on those portcos, which usually lack a real distribution engine or brand.

We''ve helped SaaS and tech-adjacent brands (like ManyChat, ClickUp, Perplexity, Kalshi, and others) build their creator-led distribution and brand engines to survive the compression using a proprietary blend of herbs and spices, lol. (ie UGC-led creator distribution, whitelisted collab posts, and a lifecycle capture layer so the audience you build sticks around.)

Between expanding awareness or driving down-funnel conversion, what''s the priority right now? Or is it both?

here to help,

Tom', 1);

-- 7. Micro CPG: Resume/Credibility (vs B) (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('6e120582-ffb8-4587-abcc-1cc2e235dd62', 'Micro CPG: Resume/Credibility (vs B)', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('f261dab5-1a2c-42ac-a744-4583743aad93', '6e120582-ffb8-4587-abcc-1cc2e235dd62', 'A', '', 'Hey [First Name],

we''re actively looking to work with more growth-stage brands like [Brand] after spending the last few years doing the bigger-brand thing (clients include Jack Link''s, Perplexity, Kalshi, Ridge, Bluechew, Samsung, LG, Netflix, Erewhon, and some others you''d recognize).

most agencies that brands your size are talking to want $25K+/mo retainers you can''t justify yet, and the ones who will work for less can''t actually execute. We built a starter package specifically for brands in your window, with the full suite of what we do (creator engine, whitelisted paid, DTC/retail activation, lifecycle capture), sized and priced for where you actually are.

We know [Brand] is in that stage where every dollar has to move the business, and we''re good at that. Between lowering CAC or getting more sales velocity, what''s the priority for you right now? Or is it both?

here to help,

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('eeede797-082a-45ca-b639-a31143aca7ea', '6e120582-ffb8-4587-abcc-1cc2e235dd62', 'B', '', 'Hey [First Name],

we (Matchbook) work with / have worked with companies like:

- Jack Link''s (AOR for over three years)
- Ridge Wallet
- Erewhon
- Perplexity (did their 2025 Super Bowl campaign)
- and a handful of others you''d recognize

But we built you a starter package specifically for brands in [Brand]''s window: the full suite of what we do, sized and priced for where you actually are. we want to work with you because we know [Brand] is in that stage where every dollar has to move the business, and we know our programming works.

Between lowering CAC or more sales in general, what''s the priority for you right now? Or maybe both?

here to help,

Tom', 0);

-- 8. Micro CPG: Resume/Credibility (vs B-alt) (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('c347a939-83db-4742-8e1d-83baa88189a1', 'Micro CPG: Resume/Credibility (vs B-alt)', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('ccb36e07-108b-4771-9612-f4298d756058', 'c347a939-83db-4742-8e1d-83baa88189a1', 'A', '', 'Hey [First Name],

we''re actively looking to work with more growth-stage brands like [Brand] after spending the last few years doing the bigger-brand thing (clients include Jack Link''s, Perplexity, Kalshi, Ridge, Bluechew, Samsung, LG, Netflix, Erewhon, and some others you''d recognize).

most agencies that brands your size are talking to want $25K+/mo retainers you can''t justify yet, and the ones who will work for less can''t actually execute. We built a starter package specifically for brands in your window, with the full suite of what we do (creator engine, whitelisted paid, DTC/retail activation, lifecycle capture), sized and priced for where you actually are.

We know [Brand] is in that stage where every dollar has to move the business, and we''re good at that. Between lowering CAC or getting more sales velocity, what''s the priority for you right now? Or is it both?

here to help,

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('b87190df-8497-480c-ba48-2951a971000a', 'c347a939-83db-4742-8e1d-83baa88189a1', 'B', '', 'Hey [First Name],

we (Matchbook) work with / have worked with companies like:

- Jack Link''s (AOR for over three years)
- Ridge Wallet
- Erewhon
- Perplexity (did their 2025 Super Bowl campaign)
- and a handful of others you''d recognize

That said, we built you a starter package specifically for brands your size, inclusive of the full suite of what we do, sized and priced for where you''re actually at. Frankly, the reason we want to work with you is because we know you''re in the stage where every dollar matters and needs to move the needle. We know our programming works. Let''s jam.

Tom', 0);

-- 9. Micro CPG: Personal/Coworker (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('a3b753ab-936c-4302-a98a-1e0691d00d23', 'Micro CPG: Personal/Coworker', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('f67d75b9-c429-45ac-bd5f-e152a23ecf8b', 'a3b753ab-936c-4302-a98a-1e0691d00d23', 'A', '', 'Hey [First Name], sending you this email because [Brand] caught my attention.

Been working with brands across the DTC and retail spectrum (Jack Link''s, Ridge, some others you''d know) and we recently built a starter package specifically for smaller brands: the full suite, sized to actually work for where you are.

How are you thinking about the next 6 months on the growth side, is it "we need more velocity yesterday" or "we need to build a low-CAC foundation that scales"?

here to help,

Tom', 1);

-- 10. Micro CPG: Short & Clear (A/B)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('cd8124fe-2b46-49d0-b5b1-549bc9f238e4', 'Micro CPG: Short & Clear', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('8cfde54f-1244-4c1a-81e4-1d4ff3f40b5e', 'cd8124fe-2b46-49d0-b5b1-549bc9f238e4', 'A', '', 'Hey [First Name],

I know that you''re building [Brand]. I''m sure you also know that most agencies at your stage either want a retainer that doesn''t make sense yet, or price down to something that can''t actually move the business.

We can help. We built a starter package specifically for brands your size. It''s the full suite of what we do (of course), sized and priced to actually work. We have done this for Jack Link''s, Ridge, and a bunch of other brands you''d know.

I''m sure you''ll have questions. Let''s find some time to talk through them?

Tom', 1);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('9c1f4769-b1f6-48d9-9ac7-b7008d689739', 'cd8124fe-2b46-49d0-b5b1-549bc9f238e4', 'B', '', 'Hi [First Name],

we (Matchbook) know that [Brand] is around the [$X]M ARR mark (at least that''s what our AI tells us), and probably at the stage where you need everything working at once, DTC, creator, retail, lifecycle, but the budgets to do it right sit two zeros away. So we built a starter package to help brands at your stage based on the best ROI programming we''ve run for brands like Jack Link''s, Ridge, Erewhon, and others you''d recognize.

Between lowering CAC or getting more sales velocity, what''s the priority for you right now? Or is it both?

here to help,

Tom', 0);

-- 11. Bigger DTC: Resume/Credibility (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('87203255-de6a-4803-855d-a14a5481d7fb', 'Bigger DTC: Resume/Credibility', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('a47f05b5-443b-48a8-ad5f-e1994303e05f', '87203255-de6a-4803-855d-a14a5481d7fb', 'A', '', 'Hey [First Name],

we run influencer as a full-funnel distribution channel for brands like Jack Link''s, Ridge, Kalshi, Perplexity, Bluechew, Samsung, LG, Netflix, Erewhon, and a handful of others you''d recognize.

The way we do it is a little different: larger recognizable creators are used only to cast a credibility umbrella, and then actual conversion is driven bottom-funnel by a network of mirror-image creators running whitelisted collab posts. We use this program to bring CAC down on evergreen spend and to keep launches and seasonal/limited promos landing in a way that makes leadership happy.

At [Brand]''s stage, high-level execution in this layer is usually a missing piece, or one that pays off with deeper investment, and it''s what we''re good at.

here to help,

Tom', 1);

-- 12. Bigger DTC: Personal/Coworker (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('56732aa9-833d-4749-8d41-39a5f471b09e', 'Bigger DTC: Personal/Coworker', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('bd4db396-03bf-43bb-bdab-6e8da46b942c', '56732aa9-833d-4749-8d41-39a5f471b09e', 'A', '', 'Hey [First Name], sending you this email because [Brand] caught my attention.

We''ve been running creator-as-distribution programs (clients include Jack Link''s, Ridge, Kalshi, and some others you''d know) and [Brand] jumped out as one that clearly has the fundamentals working.

Are you actively looking to compress CAC, nail a specific launch or LTO landing, or both?

here to help,

Tom', 1);

-- 13. Bigger DTC: Short & Clear (A only)
INSERT INTO email_templates (id, name, loop, status, send_day)
VALUES ('74f5defc-939d-47b5-9907-7fc30ecc0f46', 'Bigger DTC: Short & Clear', 1, 'draft', 0);
INSERT INTO template_variants (id, template_id, slot, subject, body, is_default)
VALUES ('ab755dbd-0610-456a-9efd-c244adfd2064', '74f5defc-939d-47b5-9907-7fc30ecc0f46', 'A', '', 'Hey [First Name],

Our AI tells us that [Brand] is around the [$X]M ARR mark, and running both DTC and retail. Reaching out because at this stage CAC becomes a pressure point from leadership, so we help by running creators as a distribution channel (clients: Jack Link''s, Ridge, Perplexity, and others) using a proprietary blend of herbs and spices, lol.

Is lowering CAC on your radar right now, or is it more like nailing an upcoming LTO? Or maybe both?

here to help,

Tom', 1);
