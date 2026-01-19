# AI Companions Platform

Multi-character AI companion system with shared infrastructure.

## Structure

```
ai-companions/
├── platform/
│   ├── admin-worker/     # Central admin API
│   └── website/          # Main website (Cloudflare Pages)
├── templates/
│   └── character-worker/ # Template for new characters
├── characters/           # Individual character workers
├── docs/                 # Documentation
└── scripts/              # CLI helpers
```

## Quick Start

1. Platform is deployed to `companions-admin.micaiah-tasks.workers.dev`
2. Use CHARACTER_BUILDER.md to spin up new characters
3. Each character gets their own worker + R2 bucket

## Deployment

- Push to `platform/` triggers admin worker deploy
- Push to `characters/{name}/` triggers that character's deploy
