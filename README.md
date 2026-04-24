# fb3-pfd-chunk-parser

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

You can override the `.env` FB3 ids for a single run:

```bash
bun run start 71106703 110466760
```

FB3 output is written to `book_<BOOK_ID>_<title>/`, where title is lowercased and normalized to letters, digits, and `_`.

To download PDF pages:

```bash
bun run pdf
```

PDF output is written to `pdf_<PDF_BOOK_ID>_<title>/` as page images plus `metadata.md`.
You can override the `.env` PDF id for a single run:

```bash
bun run pdf 109041739
```
