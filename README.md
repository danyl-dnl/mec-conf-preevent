# MEC.CONF Pre-Event — Level 1: Interactive Pairing & Puzzle Platform

![Vite](https://img.shields.io/badge/Vite-8.3-646CFF?logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%20%7C%20Auth%20%7C%20Edge%20Functions-3ECF8E?logo=supabase&logoColor=white)
![Cloudinary](https://img.shields.io/badge/Cloudinary-Image%20Upload-3448C5?logo=cloudinary&logoColor=white)
![Oxlint](https://img.shields.io/badge/Oxlint-Passing-green?logo=oxc&logoColor=white)

An in-person gamified networking and icebreaker platform engineered for **MEC.CONF**. 

The platform matches conference attendees into secret pairs, guides them to locate each other in the venue, challenges them to solve a complementary two-screen paper-style cipher puzzle, and verifies their meetup with a partner selfie to unlock **Level 1 Completion**.

---

## 📑 Table of Contents

- [The Level 1 Experience](#-the-level-1-experience)
- [System Architecture & Features](#-system-architecture--features)
  - [Participant Flow](#participant-flow)
  - [Admin Command Center](#admin-command-center)
- [Game Mechanics: Complementary Shading Cipher](#-game-mechanics-complementary-shading-cipher)
- [Security & Data Integrity](#-security--data-integrity)
- [Tech Stack](#-tech-stack)
- [Repository Structure](#-repository-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Running Locally](#running-locally)
- [Testing & Quality Assurance](#-testing--quality-assurance)
- [Deployment](#-deployment)

---

## 🎮 The Level 1 Experience

1. **Attendee Check-In**: Attendees authenticate via passwordless email OTP linked to their unique event participant code.
2. **Partner Discovery**: Attendees receive their designated partner's name and code. They must locate each other inside the physical venue.
3. **Mutual Verification**: Attendees verify each other in person by entering each other's code or scanning a personal QR badge. Both participants must mutually verify before the puzzle unlocks.
4. **Cooperative Puzzle Solving**: Each partner receives an incomplete 5×5 matrix. Neither screen contains enough information to solve the puzzle alone. Partners place their phones side-by-side to cancel shaded decoy cells and reveal the surviving letter coordinates of their pair's unique keyword.
5. **Selfie Verification**: Once the puzzle is solved, the pair takes a partner selfie together and uploads it directly through the app.
6. **Level 1 Complete**: Both participants receive confirmation and qualify for the next stage of the event.

---

## 🛠️ System Architecture & Features

### Participant Flow
* **Zero-Password Authentication**: Secure authentication via Supabase Auth magic links/OTPs mapped to roster records.
* **Mutual Lock-Step Verification**: Prevents single-sided spoofing; both attendees must confirm the other's code.
* **Screen Privacy**: Frontend payloads strictly omit solutions, opponent fragments, and server-side validation secrets.
* **Fluid Mobile Grid**: Responsive, zero-dependency matrix rendering optimized for one-handed mobile devices with retro terminal aesthetics (`VT323` and `Space Mono`).
* **Direct Partner Photo Upload**: Automatic file size bounding (5 MB), mime-type sniffing, and upload finalization via Supabase Edge Function to Cloudinary.

### Admin Command Center (`/admin`)
* **Role-Based Access Control**: Protected by PostgreSQL Row Level Security (RLS) and `is_admin()` database policies.
* **Roster Management**:
  * Drag-and-drop CSV importer with auto-detection of column headers and real-time validation preview.
  * Manual attendee addition, editing, and safe deletion (with guardrails for paired attendees).
  * Fast search, status filters, and bulk participant removal.
* **Pair Management**:
  * One-click randomized pairing algorithm with automatic leftover handling for odd-numbered rosters.
  * Manual pairing support.
  * Automatic puzzle allocation directly from the puzzle bank upon pair creation.
* **Puzzle Bank & Authoring**:
  * Pre-seeded with 30 unique, hand-crafted space-themed puzzles.
  * In-browser puzzle generator: input any 1–12 letter keyword (A–Y) to automatically generate complementary 5×5 matrices (Grid A and Grid B).
  * Real-time admin preview showing overlay simulation, surviving coordinates, and frequency validation.
  * Keyword collision prevention: blocks duplicate target words across the bank.
* **Live Event Monitor**:
  * Real-time tracking of all pairs: Partner Check-in, Puzzle Attempts, Puzzle Solved Status, Photo Upload, and Final Completion.
  * In-dashboard preview of verified pair selfies.
* **Admin Team Management**:
  * Promote/demote organizers and manage administrative credentials directly from the UI.

---

## 🧩 Game Mechanics: Complementary Shading Cipher

```
  Partner A (Grid A)          Partner B (Grid B)          Combined Overlay
  ┌───┬───┬───┬───┬───┐       ┌───┬───┬───┬───┬───┐       ┌───┬───┬───┬───┬───┐
  │ 3 │   │ █ │   │   │       │   │ █ │   │ █ │ █ │       │ 3 │ █ │ █ │ █ │ █ │
  ├───┼───┼───┼───┼───┤       ├───┼───┼───┼───┼───┤       ├───┼───┼───┼───┼───┤
  │ █ │   │ █ │   │ █ │   +   │   │ █ │   │15 │   │   =   │ █ │ █ │ █ │15 │ █ │
  ├───┼───┼───┼───┼───┤       ├───┼───┼───┼───┼───┤       ├───┼───┼───┼───┼───┤
  │   │ █ │   │   │ █ │       │ █ │   │ █ │13 │   │       │ █ │ █ │ █ │13 │ █ │
  └───┴───┴───┴───┴───┘       └───┴───┴───┴───┴───┘       └───┴───┴───┴───┴───┘
                                                           Surviving numbers decode:
                                                           3=C, 15=O, 13=M ... -> "COMET"
```

1. **Letter-to-Number Encoding**: Letters A–Y map to alphabet positions 1–25 (Z is excluded).
2. **Deduplication & Scatter**: Duplicate letters in a keyword collapse to a single coordinate clue.
3. **Complementary Distribution**:
   - Numbered clues appear on one partner's grid while the other has an empty cell.
   - Decoy/distractor coordinates are shaded (`█`) on one partner's grid and empty on the other.
4. **Physical Overlay**:
   - Any coordinate shaded on **either** screen is discarded.
   - Any coordinate with an unshaded number is kept.
   - Participants unscramble the surviving letters to deduce the target keyword.

---

## 🔒 Security & Data Integrity

* **Zero Information Leakage**: Participant APIs return strictly the participant's assigned fragment (`grid_a` or `grid_b`). Solution keywords and paired fragments are never delivered to the client bundle.
* **Server-Side Verification**: Answer attempts are checked via database RPCs (`participant_submit_answer`) with attempt tracking and rate limits.
* **Strict Concurrency & Allocation**:
  * Puzzles from the bank are reserved using `FOR UPDATE SKIP LOCKED`.
  * Every pair receives a unique puzzle; duplicate assignments are mathematically prevented.
* **Edge Function Photo Handler**:
  * Verifies user JWT identity online against `/auth/v1/user`.
  * Atomic 5-minute photo upload reservation locks to eliminate race conditions.
  * Magic-byte and MIME validation ensures only genuine image binaries under 5 MB are sent to Cloudinary.

---

## 💻 Tech Stack

* **Frontend**: React 19, TypeScript, Vite 8, React Router 7, Lucide Icons, PapaParse
* **Styling**: Vanilla CSS with custom retro-cyberpunk design system and CSS Variables
* **Backend**: Supabase (PostgreSQL 15+, PL/pgSQL RPCs, Row-Level Security, Supabase Auth)
* **Serverless**: Deno / Supabase Edge Functions (`upload-pair-photo`)
* **Media Storage**: Cloudinary (signed server-side uploads)
* **Code Quality**: Oxlint (instant static analysis), Node Test Runner (`node:test`)

---

## 📁 Repository Structure

```text
├── docs/                      # Specification & architectural documentation
│   ├── level1-generator.md    # Complementary puzzle algorithm & bank spec
│   └── pair-photo-setup.md    # Cloudinary & edge function setup instructions
├── public/                    # Static branding, hero assets, and redirects
├── src/
│   ├── app/                   # App routes & layout entry points
│   ├── features/
│   │   └── level1/            # Level 1 feature module
│   │       ├── generator.ts   # Puzzle generator & grid math algorithms
│   │       ├── AdminProgress.tsx # Live event monitoring dashboard
│   │       ├── AdminPuzzles.tsx  # Puzzle bank authoring UI
│   │       ├── ParticipantPuzzle.tsx # Mobile complementary grid solver
│   │       └── PairPhotoUpload.tsx   # Verified selfie uploader
│   ├── pages/
│   │   ├── admin/             # Organizer console (Roster, Pairs, Admins)
│   │   └── participant/       # Attendee portal (Auth, Pairing, QR check-in)
│   ├── lib/                   # Supabase client singletons
│   └── shared/                # Common types and utilities
├── supabase/
│   ├── functions/             # Supabase Edge Functions (upload-pair-photo)
│   ├── migrations/            # Version-controlled PostgreSQL migrations & RPCs
│   ├── seeds/                 # 30-puzzle space theme seed data
│   └── tests/                 # Database authorization & RPC integration tests
├── tests/                     # Node.js and TSX component test suite
├── package.json
└── vite.config.ts
```

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v20.x or higher recommended)
* A [Supabase](https://supabase.com/) project with Database and Auth enabled
* A [Cloudinary](https://cloudinary.com/) account (for pair selfie uploads)

### Installation

```bash
# Clone the repository
git clone https://github.com/danyl-dnl/mec-conf-preevent.git
cd mec-conf-preevent

# Install dependencies
npm install
```

### Environment Variables

Create a `.env.local` file in the root directory:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

For the Supabase Edge Function (`upload-pair-photo`), configure Cloudinary secrets via the Supabase CLI:

```bash
npx supabase secrets set \
  CLOUDINARY_CLOUD_NAME=your_cloud_name \
  CLOUDINARY_API_KEY=your_api_key \
  CLOUDINARY_API_SECRET=your_api_secret \
  --project-ref your-project-ref
```

### Running Locally

```bash
# Start Vite development server
npm run dev
```

Visit `http://localhost:5173` for the Participant Portal and `http://localhost:5173/admin` for the Organizer Dashboard.

---

## 🧪 Testing & Quality Assurance

The codebase includes comprehensive test suites covering algorithmic invariants, mobile UI responsiveness, photo handler security, and database RPCs:

```bash
# Run unit & integration tests (Node native test runner)
npm test

# Run Oxlint for code analysis
npm run lint

# Build production bundle & typecheck
npm run build
```

---

## 🚢 Deployment

### Frontend (Vercel / Netlify / Cloudflare Pages)
The repository includes SPA routing configuration in both [vercel.json](file:///Users/danyl/mec.conf/vercel.json) and [public/_redirects](file:///Users/danyl/mec.conf/public/_redirects). 

Build command: `npm run build`  
Output directory: `dist`

### Backend (Supabase Migrations & Functions)
Deploy migrations and functions using the Supabase CLI:

```bash
# Push database migrations
npx supabase db push

# Deploy the photo upload Edge Function
npx supabase functions deploy upload-pair-photo --project-ref your-project-ref --use-api
```

---

## 📄 License

Internal use for **MEC.CONF**. All rights reserved.
