# Knowledge inventory (Phase 0)

Researched on 2026-11-05 against the live site, https://drluisghilino.com.ar/.
This file records what the assistant may use as a source of truth, what it must not
use, and what the site does not answer. The ingestion pipeline (Phase 2) reads this
list; it does not discover sources on its own.

## How the site is built

- One public page. `robots.txt` allows everything and `sitemap.xml` lists only
  `https://drluisghilino.com.ar`. Probing `/nosotros`, `/servicios`, `/faq` and
  `/consultorios` returns 404. `/contacto` is a 308 redirect to `/#contacto`.
- The page is split into sections with stable anchor ids: `#patologias`, `#sobre-mi`,
  `#consultorios`, `#preguntas`, `#contacto`. Sub-items also have ids
  (`#patologia-artrosis`, `#consultorio-boulogne`, ...). These anchors become the
  citation URLs, so an answer can link to the exact section.
- The page embeds schema.org JSON-LD (`IndividualPhysician`, `Person`, two
  `PhysiciansOffice`, `FAQPage`) with addresses, coordinates, opening hours, phone and
  e-mail in machine-readable form.
- `https://drluisghilino.com.ar/llms.txt` is a Markdown summary of the same facts.
- Response headers: `x-frame-options: SAMEORIGIN`, `x-content-type-options: nosniff`,
  HSTS, and **no Content-Security-Policy**. The embed script can load today; if a CSP is
  added later it must allow the widget's script origin (`script-src`) and API origin
  (`connect-src`). See DEPLOYMENT.md.

## Authoritative sources

| id            | URL                                          | Format   | Used for                                                                                     |
| ------------- | -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `site-home`   | https://drluisghilino.com.ar/                | HTML     | RAG chunks (one per section / item), canonical citation URLs with `#anchor`                  |
| `site-jsonld` | JSON-LD inside https://drluisghilino.com.ar/ | JSON     | Structured clinic facts for the tools (offices, hours, contact, credentials)                 |
| `site-llms`   | https://drluisghilino.com.ar/llms.txt        | Markdown | Cross-check only. It duplicates the page, so its chunks are deduplicated against `site-home` |

Not sources (linked from the page but outside the doctor's control or not content):
the footer "Desarrolladores" link (pastebin.com), Google Maps links, `wa.me`, `tel:`
and `mailto:` links. The contact links are kept as _contact channels_ in the structured
facts, not as documents.

## What the site says (verified 2026-11-05)

**Doctor.** Dr. Luis Antonio Ghilino, médico traumatólogo. Consultorio privado de
Ortopedia y Traumatología. Más de 25 años de experiencia. Diagnóstico y tratamiento de
patologías crónicas. Graduado en la Universidad de Buenos Aires (Facultad de Medicina).
Colegio de Médicos de la Provincia de Buenos Aires, Distrito IV. Matrícula Provincial
445565. Ex integrante del Servicio de Ortopedia y Traumatología del Hospital Castex
(San Martín) y del Servicio de Traumatología del Hospital Central de San Isidro.

**Pathologies and treatments (`#patologias`).** Artrosis; Reuma; Columna (dolor de
espalda y de columna); Infiltraciones de rodilla con ácido hialurónico; Inmovilizaciones
con yeso; Plantillas y pie plano (corrección del arco del pie). Each has a one-line
description and nothing more.

**Offices and hours (`#consultorios`).**

| Office                           | Address                                                     | Days and hours                                               | Appointment                                    |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| San Miguel                       | D'Elía 1367, San Miguel (maps: "Maestro Ángel D'Elía 1367") | Jueves desde las 17 h                                        | Sin turno previo, por orden de llegada         |
| Boulogne (partido de San Isidro) | Virrey Vértiz 117, Boulogne                                 | Lunes, martes y viernes desde las 18 h; sábados de 10 a 12 h | Confirmar la consulta por WhatsApp antes de ir |

**Fee.** "Valor de la consulta: $50.000".

**Contact (`#contacto`).** WhatsApp and phone 011 4033-6567 (+54 9 11 4033-6567),
e-mail doctorghilino@gmail.com. The page's form does not send anything: it opens
WhatsApp or the mail client with the message filled in ("Este sitio no guarda tus
datos").

**FAQ (`#preguntas`).** Eight Q&As: where he works, days and hours, whether an
appointment is needed, the fee, how to book, which pathologies, knee infiltrations,
training and license.

**Footer disclaimer.** "La información de este sitio no reemplaza la consulta médica."

## Questions a visitor is likely to ask

Administrative (answerable from the site): ¿Dónde atiende? ¿Qué días? ¿Hasta qué hora?
¿Necesito turno? ¿Cómo saco turno? ¿Cuánto sale la consulta? ¿Cuál es el WhatsApp?
¿Atiende en San Isidro? ¿Qué matrícula tiene? ¿Dónde estudió? ¿Hace infiltraciones?
¿Trata la artrosis / el pie plano / la columna? ¿Cómo llego al consultorio?

Clinical (must be declined and redirected): "Me duele la rodilla, ¿qué tengo?",
"¿Me conviene una infiltración?", "¿Qué remedio tomo?", "Te paso mi resonancia".

## Gaps and ambiguities (the assistant must not fill these in)

1. **Obras sociales / prepagas.** Not mentioned anywhere. Likely the most common question
   the site does not answer. The assistant should say so and point to WhatsApp.
2. **Closing times.** Only start times are published ("desde las 17 h", "desde las 18 h").
   No end time for San Miguel or for Boulogne on weekdays.
3. **Payment methods.** Not published.
4. **Fee validity.** "$50.000" has no date. Prices in Argentina change often, so the
   assistant should present it as "según el sitio" and suggest confirming.
5. **Surgery, children, sports injuries, fractures, emergencies.** Not mentioned. The site
   lists chronic pathologies only. "Ortopedia y Traumatología" is the field, not a list
   of services, so the assistant must not infer that he operates or treats children.
6. **"San Isidro".** Ambiguous on purpose: Boulogne is in the _partido_ of San Isidro,
   and the Hospital Central de San Isidro is a _past_ position, not an office.
7. **Hospital Castex.** A past position. "¿Lo encuentro en el Castex?" must not be
   answered with yes.
8. **Offices no longer listed.** Older versions of the site listed other offices. Only
   San Miguel and Boulogne are current; the assistant must not mention others.
9. **Emergency numbers.** The site gives none. The safety policy needs one; Argentina's
   medical emergency number is 107 and the general one is 911. This is a safety
   constant set by the administrator (see `SAFETY_EMERGENCY_TEXT` in `.env.example`),
   not website knowledge, and the doctor's office should confirm the wording.

## Size of the corpus, and why that matters

The whole page is about 2,500 tokens of text. That fits in a prompt many times over, so
for _today's_ content, putting the whole site into the system prompt would work and cost
very little. We still build retrieval because the knowledge base is meant to grow (PDFs,
curated FAQs, administrator notes), because chunk-level retrieval gives precise
citations, and because the abstention threshold needs a relevance score. The evaluation
(Phase 7) includes a "full context" baseline so the comparison is measured, not assumed.
