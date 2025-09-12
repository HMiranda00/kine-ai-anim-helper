Kine AI Anim Helper (static)

Minimal web app (Express backend + static frontend) using Replicate to generate images and videos, following the attached Obsidian canvas flow.

Models
- bytedance/seedream-3 — text-to-image
- google/nano-banana — image editing
- bytedance/seedance-1-lite — text/image-to-video

Quick start
1) Requisitos: Node 18+.
2) Crie um arquivo .env na raiz com:
   REPLICATE_API_TOKEN=r8_...
3) Instale e rode:
   npm install
   npm start
4) Abra http://localhost:3000

Notas
- O backend expõe:
  - POST /api/files — envia arquivo ao Replicate e retorna a URL temporária
  - POST /api/run — dispara uma previsão e aguarda até concluir, retorna output
  - GET  /api/health — healthcheck
- O token agora fica somente no servidor (não há campo de token no front).
4) Use the Frames canvases to upload or set start/end frames.
5) Generate images with Seedream-3 or edit with Nano-Banana.
6) Send generated/edited images to Start/End frames.
7) Generate a video with Seedance-1-lite, using prompt + frames.

Notes
- All calls are done client-side with fetch against Replicate API.
- Local files are uploaded first to /v1/files to obtain temporary URLs.
- Token is stored locally (localStorage + sessionStorage). Remove by clearing site data.

Schema references
- Seedream-3: https://replicate.com/bytedance/seedream-3/api/schema
- Nano-Banana: https://replicate.com/google/nano-banana/api/schema
- Seedance-1-lite: https://replicate.com/bytedance/seedance-1-lite/api/schema


