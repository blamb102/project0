# Project Name
Basic hello world webpage that is tested locally and runs on aws.

## Stack
- Frontend: React + Tailwind (planned)
- Backend: Express + Node.js (planned)
- Database: PostgreSQL via Prisma (planned)
- Hosting: AWS (S3/CloudFront + App Runner + RDS)

## Commands
- Dev: `docker-compose up -d`
- Frontend dev: `cd web && npm run dev`
- Backend dev: `cd api && npm run dev`
- Test: `npm test`
- Build: `npm run build`

## Structure
web/        # React frontend
api/        # Express backend
infra/      # CDK infrastructure code
docs/       # Architecture decisions

## Rules
- Conventional commits: feat:, fix:, docs:, chore:
- Never commit secrets — use .env files (gitignored)
- Never commit directly to main — always branch
- IMPORTANT: Never modify /migrations directly
