# Sherlock Reader

A simple, Word-style web app for reading **The Complete Sherlock Holmes** and learning English.

- **Read** every novel and story, split into chapters, with a contents menu, bigger/smaller text and white, sepia or dark pages.
- **Never lose your place**: the app remembers where you stopped and opens there next time. Tap any line and choose **Bookmark here** to keep extra bookmarks.
- **Save new words with their sentence**: select a word or phrase (double-click on a computer, press and hold on a phone) and tap **＋ Save word**. The whole sentence is saved with it, and you can switch to the whole paragraph or add your own note.
- **Export for AI**: in *Vocabulary*, tap **Export for AI** to download a Markdown file (or **Copy for AI** to copy it). It already contains instructions asking the AI to explain each word as used in its sentence, translate it, and give examples. Paste or upload it to any AI chat.
- **Your data stays on your device** (browser storage). Use *Back up all data* / *Restore backup* in the Vocabulary panel to move it between phone and computer.

Works offline after the first visit, and can be added to the phone home screen ("Add to Home Screen").

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (plain HTML/CSS/JS, no build step) |
| `book/book.json`, `book/images/` | The book, converted from the .docx |
| `tools/build_book.py` | Re-creates `book/` from the .docx: `python3 tools/build_book.py The_Complete_Sherlock_Holmes.docx` |
| `tools/build_single.py` | Makes one self-contained `.html` file that opens offline by double-click |

## Run locally

```
python3 -m http.server 8000
```
then open http://localhost:8000.
