# fb3-pdf-chunk-parser

Small scripts for parsing book content.

The project supports two modes:
- FB3 chunks: text chunks, extracts chapters, and writes them as Markdown files.
- PDF pages: page images and writes a small `metadata.md` file.

## Setup

Install dependencies:

```bash
bun install
```

Create `.env` in the project root:

```env
BOOK_ID=your_book_id
VERSION_ID=your_version_id
BASE_URL=https://example.com/
PDF_BOOK_ID=your_pdf_book_id
```

Create `cookies.txt` in the project root and paste the authenticated Cookie header value into it if needed.

## Download FB3 Text

Run with values from `.env`:

```bash
bun run start
```

Override `BOOK_ID` and `VERSION_ID` for one run:

```bash
bun run start :book_id :book_version 
```

Output is written to:

```text
book_<BOOK_ID>_<normalized_title>/
```

Each chapter is saved as a separate Markdown file. The generated `index.md` links to named chapters.

## Download PDF Pages

Run with `PDF_BOOK_ID` from `.env`:

```bash
bun run pdf
```

Override `PDF_BOOK_ID` for one run:

```bash
bun run pdf :id 
```

Output is written to:

```text
pdf_<PDF_BOOK_ID>_<normalized_title>/
```

The directory contains downloaded page images and `metadata.md`.

## Development

```bash
bun run typecheck
bun run lint
bun run fmt:check
```
