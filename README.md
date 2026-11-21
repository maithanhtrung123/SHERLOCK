# Sherlock Reader

A simple, Word-style web app for reading **The Complete Sherlock Holmes** and learning English.

- **Read** every novel and story, split into chapters, with a contents menu, bigger/smaller text and white, sepia or dark pages.
- **Never lose your place**: the app remembers where you stopped and opens there next time. Tap any line and choose **Bookmark here** to keep extra bookmarks.
- **Save new words with their sentence**: select a word or phrase (double-click on a computer, press and hold on a phone) and tap **＋ Save word**. The whole sentence is saved with it, and you can switch to the whole paragraph or add your own note.
- **Export for AI**: in *Vocabulary*, tap **Export for AI** to download a Markdown file (or **Copy for AI** to copy it). It already contains instructions asking the AI to explain each word as used in its sentence, translate it, and give examples. Paste or upload it to any AI chat.
- **Listen with human voices**: tap *Listen* (or tap a line → *Read from here*) to play the LibriVox audiobook for that chapter, streamed from archive.org. Most books are *dramatic readings* with a different actor for each character. The current word is highlighted in yellow where exact timings exist (`book/align/`), otherwise the current paragraph is highlighted.
- **Computer voices**: switch with *🤖 Computer* in the player. The narrator, Holmes, Watson, women and other characters each get their own browser voice, with the spoken word highlighted in yellow. Change voices and speed in *Voices*.
- **Learn first, then practise (spaced repetition)**: each saved word is first *taught* (meaning in its sentence, Vietnamese translation, example, audio); tap *I understand* and it comes back for practice from the next morning. Practice uses 3 kinds of quiz: A/B/C meaning, choose the missing word (3 options), and see the meaning → type the word. Right answers come back later and later (1 day → 3 days → …); mistakes come back soon. Meanings come from a free dictionary (dictionaryapi.dev) and translations from MyMemory, or from your own AI.
- **✨ AI helper (optional)**: paste your own DeepSeek, Google Gemini, Claude or OpenAI key (Vocabulary → ✨ AI helper) for explanations in context and feedback on mistakes. With a key, the AI writes each new word's meaning for its sentence (the free dictionary is only the fallback), the part-of-speech label (adj, noun, verb…) on a word card opens an AI grammar note, and you can select any text while reading and tap **✨ Ask AI** to ask questions about it in a small chat. Without a key you still get dictionary meanings and short grammar notes. The key stays in your browser and is never included in exported files.
- **My progress**: % of the book read, chapters finished per book, streak, words remembered. *Export my learning* saves everything (position, finished chapters, bookmarks, words + review schedule, streak) in one .json file; *Import to continue* merges it back on any device without deleting anything. *Progress report* makes a readable .md summary you can give to an AI.
- **Your data stays on your device** (browser storage) until you export it.

Works offline after the first visit, and can be added to the phone home screen ("Add to Home Screen").

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (plain HTML/CSS/JS, no build step) |
| `book/book.json`, `book/images/` | The book, converted from the .docx |
| `tools/build_book.py` | Re-creates `book/` from the .docx: `python3 tools/build_book.py The_Complete_Sherlock_Holmes.docx` |
| `book/audio.json` | Which LibriVox recording/track belongs to each chapter (`python3 tools/build_audio.py`) |
| `book/align/*.json` | Exact word timings for the audiobook (`python3 tools/align_audio.py SECTION_ID ...`, needs `pip install faster-whisper` and ffmpeg) |
| `tools/build_single.py` | Makes one self-contained `.html` file that opens offline by double-click |

## Run locally

```
python3 -m http.server 8000
```
then open http://localhost:8000.
