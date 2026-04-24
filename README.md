# fb3-chunk-parser

## Configuration

Create a `.env` file in the root of the project with the following structure:

```env
BOOK_ID=your_book_id
VERSION_ID=your_version_id
BASE_URL=https://www.litres.ru/
PDF_BOOK_ID=your_pdf_book_id
```

To run:

```bash
bun run index.ts
```

To download PDF pages:

```bash
bun run pdf
```

PDF output is written to `pdf_<PDF_BOOK_ID>/` as page images plus `metadata.md`.

You can override the `.env` PDF id for a single run:

```bash
bun run pdf 109041739
```
