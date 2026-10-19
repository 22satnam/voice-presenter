# Voice Presenter

Three bundled PowerPoint presentations, with their original slide layouts as images:

- Business Market Analysis — 20 slides
- Print Media Advertising — 18 slides
- Diabetes Mellitus — 15 slides

There is no PowerPoint uploader. Text is extracted from each supplied PPTX and kept in `backend/decks`. Slide previews are in `frontend/public/slides`. The original large PPTX files are not required when the app runs.

## What the app does

Select a presentation and press **Present from here**. The backend writes a short explanation for each slide using Gemini (primary) and Groq (fallback). Groq Orpheus speaks the text; browser speech is the fallback. The app waits for speech to finish before going to the next slide. **Stop presentation** cancels generation, audio and further slide changes. You can click any slide, ask a typed question, or use Chrome/Edge voice input to ask a question. A question chooses a relevant slide and speaks the response.

No telemetry dashboard, generated demo traffic, drag-and-drop uploader, or always-on microphone.

## Local setup

Python 3.11+ and Node 20+:

```bash
cd backend
python -m venv .venv
# activate .venv
pip install -r requirements.txt
cp .env.example .env
# edit .env and add GEMINI_API_KEY and GROQ_API_KEY
uvicorn main:app --reload --port 8000
```

In another terminal:

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:5173.

## Vercel

Use the same repository in **two Vercel projects**:

| Project | Root directory | Framework | Environment variables |
|---|---|---|---|
| Web | `frontend` | Vite | `VITE_API_BASE=https://YOUR-API.vercel.app` |
| API | `backend` | FastAPI | `GEMINI_API_KEY`, `GROQ_API_KEY`, `FRONTEND_ORIGIN=https://YOUR-WEB.vercel.app` |

Optional backend vars: `GEMINI_MODEL=gemini-2.5-flash-lite`, `GROQ_ANSWER_MODEL=openai/gpt-oss-20b`.

**Keep API keys only in the backend project.** Add them to Production and redeploy. Browser audio requires a user click; the Present/Ask buttons initiate that permission. Voice input depends on browser recognition support; typing always works.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest -q
```

Real provider calls and browser audio should still be checked on the target Vercel deployments. Some supplied PowerPoints contain placeholders and template content; explanations must not invent missing details.
