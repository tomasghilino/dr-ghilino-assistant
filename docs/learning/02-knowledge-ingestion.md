# Learning notes: Phase 2, knowledge ingestion

Ingestion turns "a website" into "rows a search engine can rank". The quality of every later answer
is capped here: retrieval can only find what ingestion stored, in the shape it stored it.

## 1. Extraction: what a reader reads, not what the browser downloads

The home page is 159 KB of HTML. About 2,500 tokens of it are content; the rest is scripts, styles,
React's serialized state, SVG icons, buttons and a form. `element.textContent` on `<body>` would mix
all of it, including the JSON-LD and "Cómo llegar a San Miguel (abre Google Maps)".

`extractHtml` walks the DOM like a reader:

- drops whole categories (script, style, svg, img, form, button, nav, `aria-hidden`, `hidden`);
- drops links whose nearest block is not a sentence or list item (call-to-action buttons), but keeps
  "WhatsApp 011 4033-6567" inside the contact list;
- emits headings with the closest stable id for citations, ignoring React's generated ids
  (`_R_2plfjb_-titulo` changes between builds);
- treats `<dt>Matrícula Provincial</dt><dd>445565</dd>` as one fact, "Matrícula Provincial: 445565";
- concatenates text nodes inside one element but puts a space at element boundaries, because the
  page lays out `<span>San Miguel</span><span>D'Elía 1367</span>` with no whitespace, and the parser
  splits "D&#x27;Elía" into several text nodes.

Each rule exists because the real page broke the naive version. That is why the tests run on a
saved copy of the real page, not on toy HTML.

## 2. Chunking: deciding what a "unit of retrieval" is

Retrieval returns chunks, not documents. Too big, and a chunk mixes topics: "Boulogne" and "San
Miguel" in one chunk means a question about Saturdays retrieves San Miguel's hours too, and the model
has to untangle them. Too small, and a chunk loses its context: "Jueves desde las 17 h" alone does not
say which office.

We use the page's own outline (heading-aware chunking) and add the context back with a **heading-path
prefix**:

```
Dr. Luis Antonio Ghilino › Consultorios › Boulogne
Lun, mar y vie · Sábados
Virrey Vértiz 117, Boulogne (San Isidro)
...
```

That first line is embedded with the rest, so the vector "knows" it is about the Boulogne office.
This is a cheap form of what Anthropic calls _contextual retrieval_ (prepending document context to
each chunk before embedding).

Overlap only matters when a long section must be split: the next piece repeats the last ~40 tokens
of the previous one, so a fact cut in half by the boundary is still complete somewhere.

## 3. Hashes make ingestion idempotent and cheap

Idempotent means running it twice has the same effect as running it once. Three hashes do it:

| Hash          | Of what                                  | Used for                                       |
| ------------- | ---------------------------------------- | ---------------------------------------------- |
| document hash | the extracted blocks (not the HTML)      | ignore rebuilds that only change markup        |
| version hash  | document hash + the list of chunk hashes | decide "unchanged, skip"                       |
| chunk hash    | the chunk text                           | reuse an existing embedding for identical text |

Plus the **pipeline fingerprint**: if the chunker settings or the embedding model change, the
fingerprint changes, and everything is re-indexed even though the site did not change.

Measured: the second real run made zero embedding calls; editing one pathology re-embedded one chunk
and reused 21.

## 4. Deduplication: coverage instead of similarity

llms.txt repeats the home page. Indexing both would return two near-identical chunks for one
question, wasting context and confusing citations. Pairwise similarity fails here because llms.txt
regroups facts (one list for both offices). So we ask: _what fraction of this chunk's 3-word sequences
already appears anywhere in the more authoritative source?_ That is **containment**.

Result on the live site: the 8 FAQ answers score 1.00 (dropped); "Consultorios y horarios" 0.87
(dropped); the summary profile 0.67, the contact line with the international number 0.64 and the
compact pathology list 0.72 (kept, because they add something).

## 5. Publishing atomically

`kb_publish_document_version` does six things in one SQL function call, which Postgres runs as one
transaction: upsert the document, supersede the old version, insert the new version, insert all
chunks, move the pointer, prune old chunks. A vector of the wrong size in chunk 2 rolls back all six
(tested). Retrieval never sees half a document.

## 6. A first look at the numbers that drive abstention

We asked the stored vectors three questions with Voyage query embeddings:

| Question                                     | Top match                                 | Cosine similarity |
| -------------------------------------------- | ----------------------------------------- | ----------------- |
| ¿atiende los sábados?                        | FAQ "¿Qué días y en qué horario atiende?" | 0.507             |
| ¿cuánto sale la consulta?                    | FAQ "¿Cuánto cuesta la consulta?"         | 0.671             |
| ¿aceptan obra social OSDE? (not on the site) | "Consultorios"                            | 0.227             |

The unanswerable question's best match is far below the answerable ones. Phase 3 turns this
observation into a measured threshold.

## Self-check questions

1. Why would hashing the raw HTML cause a full re-index after every site deploy?
2. What would go wrong if chunks had no heading-path line?
3. Why does the dedupe step only let _higher-priority_ chunks cover lower-priority ones?
4. A run fails while fetching llms.txt. Why must the pipeline not remove the llms.txt document?
5. You switch `EMBEDDINGS_MODEL` to a different model. What forces every chunk to be re-embedded?
