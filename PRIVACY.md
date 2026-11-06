# Privacy

Status: **draft** (Phase 0, 2026-11-05). It describes the design; each statement about our own
system is checked by tests as it is implemented. Third-party terms were read on 2026-11-05 and
can change; re-check them before production and once a year.

## What a visitor's message goes through

1. **The visitor's browser → our API** (InsForge edge function). HTTPS.
2. **Our API → Voyage AI** (MongoDB), to turn the question into an embedding for search.
3. **Our API → Anthropic**, which generates the answer (Claude Haiku 5.5).
4. **Our API → our database** (InsForge Postgres): the last few turns, encrypted, for 30 minutes.

Nothing is sent to the doctor, and nothing is written to the site's Google Analytics by the widget.

## What we store, and for how long

| Data                                                                 | Where                    | How long                                        | Readable by                                      |
| -------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- | ------------------------------------------------ |
| Last 6 turns of a conversation                                       | `chat_sessions`, AES-GCM | 30 minutes after the last message, then deleted | Only the API, which holds the key in its secrets |
| Request metrics (latency, tokens, cost, error category, answer kind) | `request_metrics`        | 90 days, deleted by the maintenance job         | Administrators                                   |
| Rate-limit counters keyed by an HMAC of the IP                       | `rate_limit_buckets`     | Two days, deleted by the maintenance job        | Administrators                                   |
| Knowledge base (public site content)                                 | `documents`, `chunks`    | Until replaced                                  | Administrators                                   |

We do **not** store message text in logs or metrics, raw IP addresses, names, phone numbers or
any account. The visitor can delete the conversation from the widget at any time.

Before the model sees a message, phone numbers, e-mail addresses and DNI-like numbers are
replaced with placeholders, and the widget asks visitors not to share health or personal data.

## Third parties (as of 2026-11-05)

**Anthropic (Claude API).** The two official sources read differently, so both are quoted:

- API docs: "Conversation content (your prompts and Claude's outputs) is not retained by default;
  the exception is Covered Models, which require 30-day retention." Covered Models are Claude
  Fable 5.1, Mythos 5.1, Fable 5 and Mythos 5. Haiku 5.5, our default, is not one of them.
  ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention))
- Privacy Center: "we automatically delete inputs and outputs on our backend within 30 days of
  receipt or generation". ([How long do you store my organization's data](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data))
- Training: "By default, we will not use your inputs or outputs from our commercial products"
  for training ([Privacy Center](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)).
- Exceptions: content flagged by Anthropic's automated trust and safety systems may be retained up
  to 2 years (classification scores up to 7 years), and data may be retained where required by law.
- Zero data retention exists by agreement with Anthropic's sales team; this project does not have it.

So the honest statement is: _Anthropic does not train on these conversations by default and
deletes them within 30 days at most, except content flagged for safety review or required by law._

**Voyage AI (MongoDB), embeddings.** MongoDB's docs say it "can collect the data that you send to
the Atlas Embedding and Reranking API and use it to improve Voyage AI models" and that the setting
is managed per organization ([model training data](https://www.mongodb.com/docs/voyageai/management/model-training-data/)).
**Turned off on 2026-11-05** by the account owner: Organization Settings → "Help Improve Voyage AI
Models" = Off. The toggle only appears once a valid payment method is on file, so a card is required
for the opt-out even though usage stays inside the free tokens. Re-check the setting before launch and
after any change to the Atlas organization. Only the visitor's question (after redaction) is sent, not
the conversation. A project-level rate limit in Atlas caps the damage if the key ever leaks.

**InsForge** hosts the function and the database. Function logs are InsForge's; our code does not
write message content to them.

## What we must not claim

- That conversations are "never stored" or "never processed by third parties": they are processed
  by Anthropic and Voyage, and retained by them as described above.
- HIPAA or any health-data certification: none applies to this setup.

## Visitor-facing text (widget)

> Soy un asistente virtual con inteligencia artificial. Respondo con la información publicada en
> este sitio y no reemplazo una consulta médica. No compartas datos personales ni de salud.
