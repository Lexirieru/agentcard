---
title: GiwaCard — GASOK Application Material (Draft)
type: grant-application
program: GASOK — GIWA Accelerator for Sustainable On-chain Kernel
program_url: https://giwa.io/gasok
tracks: AI/WEB3 (primary), GIWA-NATIVE IDEAS (secondary)
date: 2026-08-01
status: DRAFT — belum disubmit / not submitted
origin: docs/plans/2026-08-01-001-feat-giwacard-mvp-plan.md (U12), docs/brainstorms/2026-08-01-giwa-agent-card-requirements.md
---

# GiwaCard — Materi Aplikasi GASOK / GASOK Application Material

## Cara memakai dokumen ini / How to use this document

**ID.** Dokumen ini adalah draf jawaban untuk form aplikasi GASOK. Setiap seksi ditulis dua kali dan paralel: versi Bahasa Indonesia (`#### ID`) lebih dulu, lalu versi Bahasa Inggris (`#### EN`). Versi Inggris adalah teks yang dimaksudkan untuk disubmit; versi Indonesia ada agar pemohon dapat meninjau dan menyunting isinya dengan tepat. Placeholder ditulis `[ISI: ...]` di bagian Indonesia dan `[FILL: ...]` di bagian Inggris — **dokumen ini tidak boleh disubmit selama masih ada placeholder yang tersisa.** Semua angka pencapaian, ukuran tim, dan traksi sengaja dikosongkan, bukan dikarang. Daftar lengkap hal yang harus diisi pemohon ada di Seksi 9.

**EN.** This document is a draft of the answers for the GASOK application form. Every section appears twice and in parallel: the Indonesian version (`#### ID`) first, then the English version (`#### EN`). The English text is what is intended for submission; the Indonesian text exists so the applicant can review and edit the substance accurately. Placeholders are written `[ISI: ...]` in the Indonesian half and `[FILL: ...]` in the English half — **this document must not be submitted while any placeholder remains.** All achievement figures, team size, and traction numbers are deliberately left blank rather than invented. The full list of what the applicant must supply is in Section 9.

**Catatan status aplikasi / Application status note.** Tenggat aplikasi yang diperpanjang adalah 31 Juli 2026 dan sudah lewat per 1 Agustus 2026. Halaman program tidak menyatakan pendaftaran ditutup dan menyebutkan bahwa aplikasi baru masih diterima selama Phase 2. Seksi 8 memuat permintaan konfirmasi kelayakan secara eksplisit. / The extended application deadline was 31 July 2026 and has lapsed as of 1 August 2026. The program page does not state that applications are closed and does state that new applications are accepted during Phase 2. Section 8 contains an explicit request to confirm eligibility.

---

## 1. Ringkasan satu kalimat dan elevator pitch / One-liner and elevator pitch

#### ID

**Satu kalimat.** GiwaCard adalah rel pembayaran nonkustodial (*non-custodial*) untuk AI agent di GIWA: kartu belanja sekali-pakai onchain dengan batas nominal, cakupan merchant, dan masa berlaku yang ditegakkan oleh *smart contract*, bukan oleh prompt.

**Elevator pitch.** AI agent semakin sering diberi tugas yang berujung pada pembayaran — memanggil API berbayar, membeli data, menyewa komputasi. Satu-satunya cara agent bisa membayar hari ini adalah diberi akses ke dompet, dan itu berarti satu kesalahan model atau satu *prompt injection* cukup untuk menguras seluruh saldo. GiwaCard menghapus pilihan itu. Pemilik dana menyetor ke *vault* miliknya sendiri di GIWA, memberi agent sebuah kunci sesi dengan *policy* (batas per kartu, batas harian, daftar merchant yang diizinkan, masa berlaku maksimum), lalu agent mencetak kartu sekali-pakai untuk setiap pembayaran. Kartu hangus setelah satu penagihan berhasil, dan sisa dana yang tidak terpakai langsung kembali tersedia. Permintaan di luar *policy* tidak ditolak diam-diam — permintaan itu masuk antrean persetujuan yang hanya bisa diputuskan pemilik dana, dalam maksimal dua interaksi. Kuncinya: batas ditegakkan di kontrak, sehingga agent yang salah atau disusupi tetap tidak bisa melampauinya. Agent terhubung lewat MCP server dan Agent Skill; manusia memakai CLI interaktif dan dasbor minimal. Loop pembayaran ditutup oleh merchant pertama yang kami bangun sendiri: API berbayar bergaya x402 yang menagih per-permintaan ke kartu tersebut.

#### EN

**One-liner.** GiwaCard is a non-custodial payment rail for AI agents on GIWA: one-time onchain spend cards whose amount cap, merchant scope, and expiry are enforced by a smart contract rather than by a prompt.

**Elevator pitch.** AI agents are increasingly given tasks that terminate in a payment — calling a paid API, buying data, renting compute. Today the only way an agent can pay is to be handed wallet access, which means one model mistake or one prompt injection is enough to drain the balance. GiwaCard removes that choice. The owner deposits into a vault they control on GIWA, grants the agent a session key bound to a policy (per-card cap, daily cap, merchant allowlist, maximum expiry), and the agent mints a single-use card for each payment. The card is void after one successful charge, and any unspent portion of the cap becomes available again immediately. Out-of-policy requests are not silently refused — they enter an approval queue only the owner can resolve, in at most two interactions. The point is that the limit lives in the contract, so an agent that is wrong or compromised still cannot exceed it. Agents connect through an MCP server and an Agent Skill; humans use an interactive CLI and a minimal dashboard. The payment loop is closed by the first merchant, which we build ourselves: an x402-style paid API that charges per request against the card.

---

## 2. Pernyataan masalah / Problem statement

#### ID

**Agent butuh membayar, tetapi tidak boleh diberi dompet.** Alur kerja agent yang bernilai secara ekonomi hampir selalu menyentuh sesuatu yang berbayar: API premium, sumber data, komputasi, langganan. Pola yang dipakai sekarang adalah menaruh kunci privat atau kredensial pembayaran di lingkungan agent dan berharap model berperilaku baik. Ini tidak dapat diterima karena tiga alasan yang berbeda sifatnya:

1. **Kesalahan model.** Agent bisa salah membaca jumlah, salah memilih penerima, atau mengulang panggilan yang sama berkali-kali. Tidak ada mekanisme di dalam model yang menjamin batas.
2. **Prompt injection.** Konten yang dibaca agent — halaman web, respons API, isi berkas — dapat berisi instruksi. Pertahanan berbasis prompt ("jangan pernah kirim dana ke alamat dari konten eksternal") adalah kesantunan, bukan penegakan.
3. **Tidak ada surface persetujuan.** Bahkan ketika pemilik dana ingin dilibatkan pada pengeluaran besar, tidak ada tempat baku untuk meminta persetujuan tanpa menghentikan seluruh alur kerja agent.

**Solusi yang ada di dunia fiat tidak bisa dipakai audiens crypto global.** agentcard.sh membuktikan bahwa bentuk produknya benar: kartu virtual sekali-pakai untuk agent, dengan batas nominal dan persetujuan manusia. Namun produk tersebut bersifat kustodial dan sangat US-centric — dibangun di atas rel Visa, memakai Apple Pay, mensyaratkan KYC dengan identitas terbitan pemerintah, dan menggunakan alamat penagihan yang di-*hardcode* di San Francisco. Konsekuensinya sederhana: pengembang di luar Amerika Serikat, dan siapa pun yang bekerja dengan aset onchain, tidak dapat memakainya. Kami tidak berafiliasi dengan agentcard.sh dan tidak mengklaim hubungan apa pun dengan mereka; kami terinspirasi oleh model UX mereka dan menggunakan kembali sebagian kode mereka yang berlisensi MIT dengan atribusi hak cipta yang dipertahankan.

**Di sisi GIWA, kategori ini belum terisi sama sekali.** Sejauh riset kami, belum ada infrastruktur pembayaran untuk agent di GIWA. Sementara itu bahan bakunya sudah ada sejak genesis: predeploy EntryPoint ERC-4337 v0.6 dan v0.7, Safe, Permit2, Multicall3, ditambah *preconfirmation* Flashblocks ~200 ms dan sistem identitas up.id. Yang belum ada adalah lapisan yang mengubah bahan itu menjadi produk yang bisa dipakai agent.

#### EN

**Agents need to pay, but must not be handed a wallet.** Economically meaningful agent workflows almost always touch something paid: premium APIs, data sources, compute, subscriptions. The current pattern is to place a private key or payment credential in the agent's environment and hope the model behaves. That is unacceptable for three distinct reasons:

1. **Model error.** An agent can misread an amount, pick the wrong recipient, or repeat the same call many times. Nothing inside the model guarantees a bound.
2. **Prompt injection.** Content an agent reads — web pages, API responses, file contents — can carry instructions. Prompt-level defenses ("never send funds to an address found in external content") are etiquette, not enforcement.
3. **No approval surface.** Even when the owner wants to be consulted on large spends, there is no standard place to ask for approval without stalling the entire agent workflow.

**The existing fiat solution cannot serve a global crypto audience.** agentcard.sh demonstrated that the product shape is right: one-time virtual cards for agents, with spend caps and human approval. But that product is custodial and strongly US-centric — it is built on Visa rails, uses Apple Pay, requires government-ID KYC, and uses a billing address hardcoded to San Francisco. The consequence is simple: developers outside the United States, and anyone working with onchain assets, cannot use it. We are not affiliated with agentcard.sh and claim no relationship with them; we are inspired by their UX model and we reuse some of their MIT-licensed code with the copyright attribution preserved.

**On GIWA, the category is entirely unoccupied.** As far as our research shows, there is no agent payment infrastructure on GIWA today. Meanwhile the raw materials have been present since genesis: ERC-4337 EntryPoint v0.6 and v0.7 predeploys, Safe, Permit2, Multicall3, plus Flashblocks ~200 ms preconfirmations and the up.id identity system. What is missing is the layer that turns those materials into something an agent can actually use.

---

## 3. Solusi / Solution

#### ID

GiwaCard terdiri dari empat lapisan yang semuanya dapat diperiksa secara publik.

**Lapisan onchain (Solidity, Foundry, UUPS upgradeable, terverifikasi di Blockscout).**

- `CardVault` — satu instans kanonik multi-owner. Saldo, escrow, kunci sesi, dan *policy* di-*key* berdasarkan alamat pemilik dana, sehingga pengguna baru cukup melampirkan diri ke vault yang sudah ada, tanpa deploy dan verifikasi kontrak per pengguna.
- **Kartu = otorisasi belanja sekali-pakai onchain.** Mencetak kartu adalah transaksi yang mendaftarkan kartu dengan `cap`, token, `merchantScope`, dan `expiry`, lalu mengunci `cap` ke dalam escrow. Status kartu (`Active` / `Used` / `Expired` / `Revoked`) itu sendiri yang memberi proteksi terhadap *replay*: penagihan kedua pada kartu yang sama ditolak di level kontrak.
- **Escrow dengan akumulator tunggal.** `availableBalance = balance − escrowedTotal`. Kartu yang hangus — terpakai, kedaluwarsa, atau dibatalkan — melepaskan sisa escrow kembali ke saldo tersedia tanpa aksi pemilik dana.
- **Policy kunci sesi.** Kunci sesi agent terdaftar di vault dengan `capPerCard`, `dailyCap`, `merchantAllowlist`, dan `maxExpiry`. Semua dievaluasi di kontrak saat pencetakan. Pemilik dana dapat mencabut kunci sesi kapan saja.
- **Jalur persetujuan.** Permintaan di luar *policy* tidak mencetak apa pun. Permintaan itu masuk antrean; pemilik dana menandatangani struct kartu EIP-712 dan mencetak kartu itu sendiri. `approvalId` bersifat sekali-pakai. Antrean punya TTL sehingga permintaan yang tidak diputuskan berakhir di status terminal yang deterministik tanpa dana bergerak.

**Lapisan agent.** MCP server berjalan lokal lewat stdio (`npx giwacard mcp`), mengekspos alat: cetak kartu, lihat status kartu, batalkan kartu, baca saldo, baca *policy*, cek status persetujuan. **Alat untuk menyelesaikan persetujuan sengaja tidak pernah tersedia lewat MCP** — hanya pemilik dana yang bisa, lewat CLI atau dasbor. Kunci sesi tidak pernah meninggalkan mesin pemilik dana dan hasil alat diredaksi dua lapis, sehingga agent hanya melihat `card_id` yang opaque dan tidak pernah menerima material yang bisa ditandatangani. Agent Skill mendokumentasikan kosakata, alur kerja, aturan keselamatan, dan tabel kesalahan yang dapat ditindaklanjuti.

**Lapisan manusia.** CLI interaktif satu perintah (`npx giwacard`) menjalankan *wizard* onboarding lengkap: buat atau impor dompet, lampirkan ke vault, klaim faucet, buat kunci sesi, tetapkan *policy*, tulis konfigurasi MCP ke agent. Dasbor web minimal menampilkan saldo, kartu aktif dan hangus, antrean persetujuan, dan riwayat transaksi yang dibangun dari event vault. Kemampuan inti tersedia setara di kedua jalur.

**Lapisan merchant.** Merchant pertama kami bangun sendiri agar demo menghasilkan nilai nyata, bukan toko simulasi: sebuah API berbayar bergaya x402 ("GIWA Insights", laporan analitik chain yang dihasilkan on-demand) yang menagih per-permintaan. Alurnya: merchant menjawab `402` dengan syarat pembayaran, MCP server menyubmit `CardVault.charge`, lalu mengirim header `X-PAYMENT` berisi hash transaksi dan `cardId`; fasilitator memverifikasi bahwa event `Charged` yang cocok benar-benar ada di alamat vault, jumlah, dan merchant yang benar, lalu mengembalikan `200`. Fasilitator hanya membaca chain, jadi tidak memerlukan EOA berdana.

**Stablecoin uji.** Karena tidak ada test-USDC kanonik di GIWA Sepolia, kami men-deploy `gUSD` (6 desimal, UUPS) lengkap dengan faucet onchain.

#### EN

GiwaCard has four layers, all of which are publicly inspectable.

**Onchain layer (Solidity, Foundry, UUPS upgradeable, verified on Blockscout).**

- `CardVault` — a single canonical multi-owner instance. Balances, escrow, session keys, and policy are keyed by owner address, so a new user simply attaches to the existing vault; there is no per-user contract deployment or verification.
- **A card is a one-time onchain spend authorization.** Minting a card is a transaction that registers the card with a `cap`, token, `merchantScope`, and `expiry`, and locks the `cap` into escrow. The card's own state (`Active` / `Used` / `Expired` / `Revoked`) provides replay protection: a second charge against the same card reverts at the contract level.
- **Escrow via a single accumulator.** `availableBalance = balance − escrowedTotal`. A card that goes void — used, expired, or cancelled — releases the remaining escrow back to available balance without owner action.
- **Session key policy.** The agent's session key is registered in the vault with `capPerCard`, `dailyCap`, `merchantAllowlist`, and `maxExpiry`. All are evaluated in the contract at mint time. The owner can revoke a session key at any moment.
- **Approval path.** An out-of-policy request mints nothing. It enters a queue; the owner signs an EIP-712 card struct and mints it themselves. The `approvalId` is single-use. The queue has a TTL, so an unresolved request lands in a deterministic terminal state with no funds moved.

**Agent layer.** An MCP server runs locally over stdio (`npx giwacard mcp`), exposing tools to: mint a card, read card status, cancel a card, read balance, read policy, and check the status of its own approval request. **A tool to resolve approvals is deliberately never exposed over MCP** — only the owner can, via CLI or dashboard. The session key never leaves the owner's machine and tool results pass through two-layer redaction, so the agent only ever sees an opaque `card_id` and never receives signable material. An Agent Skill documents the vocabulary, workflow, safety rules, and an actionable error table.

**Human layer.** A one-command interactive CLI (`npx giwacard`) runs the full onboarding wizard: create or import a wallet, attach to the vault, claim faucets, generate a session key, set the default policy, write the MCP configuration into the agent. A minimal web dashboard shows balance, active and void cards, the approval queue, and a transaction history reconstructed from vault events. Core capabilities are at parity across both paths.

**Merchant layer.** We build the first merchant ourselves so the demo produces real value rather than a simulated store: an x402-style paid API ("GIWA Insights", on-demand chain analytics reports) charging per request. The flow: the merchant answers `402` with payment requirements; the MCP server submits `CardVault.charge` and then sends an `X-PAYMENT` header carrying the transaction hash and `cardId`; the facilitator verifies that a matching `Charged` event genuinely exists at the correct vault address, amount, and merchant, then returns `200`. The facilitator is read-only, so it needs no funded EOA.

**Test stablecoin.** Because there is no canonical test USDC on GIWA Sepolia, we deploy `gUSD` (6 decimals, UUPS) with an onchain faucet.

---

## 4. Pemetaan ke enam kriteria seleksi Phase 1 / Mapping to the six Phase 1 selection criteria

### 4.1 Kecocokan dengan chain GIWA (GIWA 체인 적합성) / Fit with the GIWA chain

#### ID

**Flashblocks membuat persetujuan terasa instan, dan itu bukan kosmetik.** Ketika agent membayar di tengah alur kerja, agent tersebut *terblokir* menunggu konfirmasi. Pada Ethereum L1 dengan interval blok 12 detik, jeda itu cukup untuk memaksa perancangan asinkron di seluruh produk. GIWA memberi interval blok 1 detik dan *preconfirmation* Flashblocks ~200 ms — cukup cepat untuk memperlakukan pembayaran sebagai pemanggilan sinkron. Kami membaca state ter-*preconfirm* untuk memberi rasa instan pada CLI, dasbor, dan alur MCP, sambil tetap memperlakukan state onchain sebagai satu-satunya kebenaran untuk status kartu; UI menandai transaksi sebagai *pending* sampai blok aman. Ini adalah kasus penggunaan yang secara khusus diuntungkan oleh properti GIWA, bukan sekadar aplikasi yang kebetulan di-deploy di sana.

**Kami membangun di atas predeploy genesis, bukan menduplikasinya.** Permit2, Safe, Multicall3, dan EntryPoint ERC-4337 v0.6 dan v0.7 sudah ada sejak genesis. Multicall3 dipakai untuk membaca state kartu dan saldo secara batch di dasbor. EntryPoint dan Safe menjadi jalur kompatibilitas akun tanpa kami perlu men-deploy infrastruktur akun sendiri. Kami menyampaikan satu hal secara jujur: MVP sengaja tidak bergantung pada *bundler* atau *paymaster*, karena GIWA belum menyediakannya secara resmi; kompatibilitas ERC-4337 penuh adalah item peta jalan, bukan klaim hari ini. Kami memilih tidak memakai Permit2 untuk *settlement* karena alasan teknis yang kami jelaskan di 4.2, dan mencatatnya sebagai jalur interoperabilitas.

**EVM-equivalent berarti tidak ada pajak porting.** Karena GIWA adalah OP Stack dan EVM-equivalent, seluruh perkakas standar berlaku: Foundry untuk kontrak, viem dengan konfigurasi chain OP Stack untuk klien, Blockscout untuk verifikasi. Waktu tim habis untuk masalah produk, bukan untuk mengakali chain.

**Jalur integrasi GIWA Wallet.** Surface persetujuan dirancang sejak awal sebagai komponen kecil dan mandiri agar dapat dipasang di dalam dompet. Argumen lengkapnya ada di 4.6.

**up.id sebagai peta jalan identitas.** Upbit Web3 Names (`up.id`) bersifat terverifikasi KYC dan *soul-bound*. Untuk pembayaran agent, itu bukan sekadar nama yang enak dibaca: daftar merchant yang diizinkan dan permintaan persetujuan menjadi jauh lebih mudah dinilai manusia jika ditampilkan sebagai `merchant.up.id` alih-alih alamat heksadesimal, dan sifat *soul-bound* plus KYC menjadikannya primitif reputasi merchant yang berarti. Kami menyatakannya sebagai peta jalan, bukan fitur MVP.

**Testnet-first mengikuti kondisi chain.** Mainnet GIWA masih dalam pengembangan, jadi target rilis kami adalah GIWA Sepolia (chain ID 91342) dengan peluncuran mainnet masuk peta jalan Phase 4 — sejalan dengan waktu chain itu sendiri, bukan mendahuluinya.

#### EN

**Flashblocks make approval feel instant, and that is not cosmetic.** When an agent pays mid-workflow, the agent is *blocked* waiting on confirmation. On Ethereum L1 with a 12-second block interval, that delay is long enough to force an asynchronous design across the whole product. GIWA gives a 1-second block interval and Flashblocks preconfirmations at ~200 ms — fast enough to treat a payment as a synchronous call. We read preconfirmed state to give the CLI, dashboard, and MCP flow their instant feel, while still treating onchain state as the single source of truth for card status; the UI marks transactions as pending until the safe block. This is a use case that specifically benefits from GIWA's properties, not an application that merely happens to be deployed there.

**We build on the genesis predeploys rather than duplicating them.** Permit2, Safe, Multicall3, and ERC-4337 EntryPoint v0.6 and v0.7 are present at genesis. Multicall3 batches card-state and balance reads for the dashboard. EntryPoint and Safe give us an account-compatibility path without deploying our own account infrastructure. One thing we state honestly: the MVP deliberately does not depend on a bundler or paymaster, because GIWA does not yet provide them officially; full ERC-4337 compatibility is a roadmap item, not a claim about today. We chose not to use Permit2 for settlement for a technical reason explained in 4.2, and we record it as an interoperability path.

**EVM equivalence means no porting tax.** Because GIWA is OP Stack and EVM-equivalent, standard tooling applies end to end: Foundry for contracts, viem with the OP Stack chain configuration for clients, Blockscout for verification. Team time goes into the product, not into working around the chain.

**GIWA Wallet integration path.** The approval surface was designed from the start as a small, self-contained component so it can be embedded inside a wallet. The full argument is in 4.6.

**up.id as the identity roadmap.** Upbit Web3 Names (`up.id`) are KYC-verified and soul-bound. For agent payments that is more than a readable name: merchant allowlists and approval requests become far easier for a human to judge when rendered as `merchant.up.id` instead of a hex address, and the soul-bound plus KYC properties make it a meaningful merchant-reputation primitive. We present this as roadmap, not as an MVP feature.

**Testnet-first follows the state of the chain.** GIWA mainnet is still under development, so our release target is GIWA Sepolia (chain ID 91342), with mainnet launch on the Phase 4 roadmap — in step with the chain's own timeline rather than ahead of it.

---

### 4.2 Orisinalitas (독창성) / Originality

#### ID

**Kategori ini belum ada di GIWA.** Sejauh riset kami, GiwaCard akan menjadi infrastruktur pembayaran agent pertama di GIWA. Kami tidak memindahkan aplikasi yang sudah jalan di chain lain; produk ini dirancang untuk properti GIWA.

**Lapisan onchain adalah pekerjaan baru, bukan porting.** Tiga bagian yang kami tulis dari nol:

1. **Vault escrow dengan akumulator tunggal.** Escrow dikunci saat pencetakan sehingga saldo tersedia selalu mencerminkan komitmen belanja yang sudah dijanjikan ke kartu aktif, dengan biaya gas yang konstan — bukan hasil penjumlahan seluruh kartu aktif, yang gasnya tidak terbatas. Pelepasan escrow untuk kartu kedaluwarsa bersifat *permissionless* karena EVM tidak punya eksekusi berbasis waktu; "otomatis" di sini berarti tanpa aksi pemilik dana, bukan tanpa transaksi. Kami menyatakan batasan itu apa adanya.
2. **Otorisasi kartu sekali-pakai.** Bukan *allowance* berulang. Setiap kartu punya cakupan merchant, batas nominal, dan masa berlaku sendiri, dan hangus setelah satu penagihan. Ini berbeda dari prior art terdekat yang kami pelajari: Coinbase spend-permissions dan Safe Allowance Module keduanya memberi *spender* tunjangan berulang dalam jendela waktu. Model kartu lebih ketat, dan lebih cocok untuk agent karena kebocoran satu kredensial kartu tidak memberi apa-apa selain satu pembayaran yang sudah dibatasi cakupannya.
3. **Settlement x402 yang diverifikasi terhadap event vault.** Skema x402 `exact_evm` yang umum menyelesaikan pembayaran dengan menarik token dari saldo penanda tangan lewat tanda tangan. Pada model kami itu tidak mungkin: dana berada di escrow di dalam vault, dan kunci sesi tidak memegang token sama sekali. Karena itu kami memakai bentuk settlement yang berbeda — penagihan dilakukan oleh vault, dan fasilitator memverifikasi *event* `Charged` yang cocok pada alamat vault, jumlah, merchant, dan `cardId`. Fasilitator menjadi *read-only* dan tidak butuh EOA berdana. Sepengetahuan kami ini adalah bentuk settlement x402 yang belum umum, dan lahir dari kebutuhan spesifik belanja terdelegasi.

**Apa yang kami gunakan kembali, dinyatakan tepat.** Kami menggunakan kembali kode berlisensi MIT dari repositori publik agentcard.sh — permukaan alat MCP, Agent Skill, dan utilitas redaksi — dengan pemberitahuan hak cipta dipertahankan di berkas `NOTICE`. Kami terinspirasi oleh model UX mereka. Kami **tidak** berafiliasi dengan mereka dan tidak mengklaim dukungan, kemitraan, atau hubungan akselerator apa pun. Seluruh lapisan onchain, model escrow, mekanisme kartu, dan skema settlement adalah pekerjaan kami sendiri.

#### EN

**The category does not exist on GIWA yet.** As far as our research shows, GiwaCard would be the first agent payment infrastructure on GIWA. We are not relocating an application that already runs on another chain; this product is designed for GIWA's properties.

**The onchain layer is new work, not a port.** Three parts are written from scratch:

1. **An escrow vault with a single accumulator.** Escrow is locked at mint so that available balance always reflects spend already committed to active cards, at constant gas cost — rather than summing over all active cards, whose gas is unbounded. Escrow release for expired cards is permissionless because the EVM has no time-triggered execution; "automatic" here means without owner action, not without a transaction. We state that limitation plainly.
2. **One-time card authorization.** Not a recurring allowance. Each card carries its own merchant scope, amount cap, and expiry, and goes void after a single charge. This differs from the closest prior art we studied: Coinbase spend-permissions and the Safe Allowance Module both grant a spender a recurring allowance over a time window. The card model is stricter, and better suited to agents because leaking one card credential yields nothing beyond a single already-scoped payment.
3. **x402 settlement verified against a vault event.** The common x402 `exact_evm` scheme settles by pulling tokens from the signer's own balance via a signature. In our model that is impossible: the funds sit in escrow inside the vault, and the session key holds no tokens at all. So we use a different settlement shape — the vault performs the charge, and the facilitator verifies a matching `Charged` event against vault address, amount, merchant, and `cardId`. The facilitator becomes read-only and needs no funded EOA. To our knowledge this is an uncommon x402 settlement shape, and it arises directly from the requirements of delegated spending.

**What we reuse, stated precisely.** We reuse MIT-licensed code from agentcard.sh's public repositories — the MCP tool surface, the Agent Skill, and redaction utilities — with the copyright notices preserved in a `NOTICE` file. We are inspired by their UX model. We are **not** affiliated with them and claim no endorsement, partnership, or accelerator relationship of any kind. The entire onchain layer, the escrow model, the card mechanism, and the settlement scheme are our own work.

---

### 4.3 Kelayakan pelaksanaan (실현 가능성) / Feasibility

#### ID

**Bukti yang kami ajukan adalah artefak yang bisa diperiksa, bukan janji.** Tonggak bukti untuk aplikasi ini adalah:

- `gUSD` dan `CardVault` ter-deploy di GIWA Sepolia dan **terverifikasi** di `sepolia-explorer.giwa.io` (implementasi dan proxy), sehingga reviewer dapat membaca kode sumber dan memanggil fungsi baca langsung dari explorer.
  Alamat: `[ISI: alamat CardVault]`, `[ISI: alamat gUSD]`, terverifikasi pada `[ISI: tanggal]`.
- **Jalur pembayaran agent yang sudah berjalan**: agent meminta kartu → kartu tercetak dengan escrow → penagihan berhasil ke API berbayar → laporan dikembalikan → kartu hangus dan sisa escrow lepas. Transaksi contoh: `[ISI: tautan tx mint]`, `[ISI: tautan tx charge]`.

**Kami tidak mengklaim MVP sudah selesai.** Per tanggal aplikasi ini, komponen yang belum rampung adalah `[ISI: komponen yang masih dikerjakan — mis. dasbor, wizard CLI, publikasi npm]`. Kami menyebutkannya secara eksplisit karena klaim kesiapan yang tidak dapat diverifikasi akan merusak kredibilitas seluruh aplikasi.

**Mengapa lingkupnya realistis.** Keputusan arsitektur kami secara sengaja menghapus ketergantungan yang paling sering membunuh jadwal:

- **Tanpa kustodi.** Dana tetap di vault pemilik. Tidak ada penyimpanan saldo pengguna, tidak ada kewajiban rekonsiliasi, dan pada tahap testnet tidak ada permukaan KYC atau kepatuhan.
- **Tanpa bundler dan paymaster.** Pencetakan dan penagihan adalah transaksi biasa dari EOA yang jelas identitasnya. Tidak ada ketergantungan pada infrastruktur ERC-4337 yang belum tersedia di GIWA.
- **Tanpa rel fiat.** Tidak ada jaringan kartu, tidak ada penyedia pembayaran, tidak ada perjanjian pihak ketiga yang harus ditunggu.
- **Satu tumpukan teknologi.** Kontrak dengan Foundry/Solidity; seluruh komponen lain TypeScript dalam satu paket yang dipublikasikan (`giwacard`) yang memuat CLI, MCP server, skill, dan daemon antrean persetujuan.
- **Satu vault kanonik.** Pengguna baru melampirkan diri, bukan men-deploy. Tidak ada beban deploy dan verifikasi per pengguna.

**Risiko yang kami ketahui dan mitigasinya.** Kami menyebutkannya lebih dulu agar reviewer tahu kami sudah mengukurnya:

| Risiko | Mitigasi |
|---|---|
| RPC publik GIWA Sepolia *rate-limited* dan dinyatakan hanya untuk pengembangan | Retry dengan *backoff* di semua klien; RPC cadangan disiapkan khusus untuk demo; latihan demo di jam sepi |
| Faucet ETH dibatasi 0,005–0,01 ETH per 24 jam | Anggaran gas dihitung di muka dan ditampilkan wizard per alamat penyubmit; volume mint+charge untuk demo jauh di bawah batas itu pada gas L2; ETH dikumpulkan beberapa hari sebelum demo |
| Verifikasi Blockscout pada OP Stack diketahui rapuh | Fallback verifikasi manual dengan *standard JSON input* melalui UI explorer; hasil verifikasi dicatat di README |
| Mainnet GIWA belum tersedia | Rilis diarahkan ke testnet; peluncuran mainnet masuk Phase 4 dan mengikuti jadwal chain |
| Basefee L1 Sepolia melonjak menaikkan biaya data | Cadangan ETH lebih dari kebutuhan nominal; anggaran diuji ulang mendekati demo |

**Kapasitas tim** dijelaskan di 4.5 dan wajib diisi pemohon sebelum submit.

#### EN

**The evidence we submit is inspectable artifacts, not promises.** The evidence milestone for this application is:

- `gUSD` and `CardVault` deployed on GIWA Sepolia and **verified** on `sepolia-explorer.giwa.io` (implementation and proxy), so a reviewer can read the source and call read functions directly from the explorer.
  Addresses: `[FILL: CardVault address]`, `[FILL: gUSD address]`, verified on `[FILL: date]`.
- **A working agent payment path**: agent requests a card → card is minted with escrow → charge succeeds against the paid API → report is returned → card goes void and the remaining escrow is released. Example transactions: `[FILL: mint tx link]`, `[FILL: charge tx link]`.

**We do not claim a finished MVP.** As of the date of this application, the components not yet complete are `[FILL: components still in progress — e.g. dashboard, CLI wizard, npm publication]`. We say so explicitly, because an unverifiable readiness claim would undermine the credibility of the entire application.

**Why the scope is realistic.** Our architectural decisions deliberately remove the dependencies that most often kill a schedule:

- **No custody.** Funds stay in the owner's vault. There is no user balance to hold, no reconciliation obligation, and at the testnet stage no KYC or compliance surface.
- **No bundler, no paymaster.** Mint and charge are ordinary transactions from clearly identified EOAs. There is no dependency on ERC-4337 infrastructure GIWA does not yet provide.
- **No fiat rails.** No card network, no payment provider, no third-party agreement to wait on.
- **A single stack.** Contracts in Foundry/Solidity; every other component is TypeScript inside one published package (`giwacard`) containing the CLI, MCP server, skill, and approval-queue daemon.
- **A single canonical vault.** New users attach rather than deploy. There is no per-user deployment and verification burden.

**Risks we know about, and their mitigations.** We list them up front so the reviewer knows we have measured them:

| Risk | Mitigation |
|---|---|
| GIWA Sepolia public RPC is rate-limited and documented as development-only | Retry with backoff in every client; a backup RPC reserved for the demo; demo rehearsals at off-peak hours |
| ETH faucet is capped at 0.005–0.01 ETH per 24 hours | Gas budget computed up front and displayed by the wizard per submitting address; the mint+charge volume needed for the demo is far below that cap at L2 gas prices; ETH accumulated over several days before the demo |
| Blockscout verification on OP Stack is known to be flaky | Manual verification fallback via standard JSON input through the explorer UI; verification outcome recorded in the README |
| GIWA mainnet is not yet available | Release targets testnet; mainnet launch sits in Phase 4 and follows the chain's own timeline |
| An L1 Sepolia basefee spike raises data costs | ETH reserve above nominal need; budget re-tested close to the demo |

**Team capacity** is addressed in 4.5 and must be filled in by the applicant before submission.

---

### 4.4 Pasar (시장성) / Market demand and growth

#### ID

**Permintaan datang dari pertumbuhan perkakas agent, bukan dari spekulasi.** Agent koding dan agent otonom kini rutin dipasang di alur kerja produksi lewat MCP dan sistem *skill*. Semakin agent dipercaya menyelesaikan tugas tanpa pengawasan langkah-demi-langkah, semakin sering tugas itu berujung pada sesuatu yang berbayar. Kebutuhannya bukan "biarkan agent membelanjakan uang" — kebutuhannya adalah "biarkan agent membelanjakan sejumlah tertentu, ke tempat tertentu, sekali saja".

**Bukti permintaan kategori dari pihak yang tidak berafiliasi dengan kami.** Testimoni publik agentcard.sh berulang pada satu tema: batas belanja yang bercakupan sempit adalah hal yang membuat alur kerja otonom aman dijalankan tanpa ditunggui. Kami mengutip tema itu sebagai bukti bahwa kategorinya punya permintaan nyata dari pengguna yang membayar, bukan sebagai klaim hubungan apa pun dengan perusahaan tersebut — kami tidak berafiliasi dengan mereka.

**Dua sisi permintaan yang berbeda.**

- **Pengembang agent** menginginkan rel yang bisa diberi batas, bukan dompet yang harus dipercaya. Bagi mereka nilai GiwaCard adalah pengurangan risiko yang bisa diaudit: batas ada di kontrak, dan hilangnya kredensial kartu bernilai nol.
- **Operator API dan merchant** menginginkan endpoint yang bisa dibayar mesin tanpa membangun penagihan, langganan, dan akun pengguna. Pola x402 memberi itu; yang kurang adalah sisi pembayar yang aman didelegasikan ke agent. GiwaCard adalah sisi pembayar itu.

**Mengapa harus rel crypto, dan mengapa itu peluang khusus GIWA.** Penerbitan kartu fiat terikat yurisdiksi: KYC identitas terbitan pemerintah, alamat penagihan, aturan jaringan kartu. Itulah sebabnya solusi yang ada tidak dapat melayani pengembang di luar Amerika Serikat. Kartu onchain tidak punya gerbang itu — global sejak hari pertama, dan dapat dipakai siapa pun yang punya dompet. Bagi GIWA, ini adalah kategori aplikasi yang mendatangkan transaksi bervolume tinggi dan bernilai kecil, persis jenis lalu lintas yang diuntungkan oleh blok 1 detik dan *preconfirmation* ~200 ms.

**Batas kejujuran.** Kami belum punya pengguna, pendapatan, atau traksi. Argumen pasar di atas bersifat kualitatif dan struktural. Jika reviewer menghendaki angka ukuran pasar, kami akan menyertakannya hanya dengan sumber yang dapat dikutip: `[ISI: angka ukuran pasar beserta sumbernya, jika pemohon ingin menyertakannya]`.

#### EN

**Demand comes from the growth of agent tooling, not from speculation.** Coding agents and autonomous agents are now routinely installed into production workflows through MCP and skill systems. The more an agent is trusted to complete a task without step-by-step supervision, the more often that task ends in something paid. The need is not "let agents spend money" — it is "let an agent spend this much, at this place, once."

**Evidence of category demand from a party unaffiliated with us.** agentcard.sh's public testimonials return repeatedly to one theme: narrowly scoped spend limits are what make autonomous workflows safe to run unattended. We cite that theme as evidence that the category has real demand from paying users, not as a claim of any relationship with that company — we are not affiliated with them.

**Two distinct sides of demand.**

- **Agent developers** want a rail they can hand a limit to, not a wallet they must trust. For them GiwaCard's value is auditable risk reduction: the limit lives in the contract, and a leaked card credential is worth nothing.
- **API operators and merchants** want machine-payable endpoints without building invoicing, subscriptions, and user accounts. The x402 pattern provides that; what is missing is a payer side that is safe to delegate to an agent. GiwaCard is that payer side.

**Why crypto rails specifically, and why that is a GIWA-shaped opportunity.** Fiat card issuing is jurisdiction-bound: government-ID KYC, billing address, card network rules. That is precisely why the existing solution cannot serve developers outside the United States. An onchain card has no such gate — global from day one, usable by anyone with a wallet. For GIWA, this is an application category that produces high-frequency, low-value transactions, exactly the traffic profile that benefits from 1-second blocks and ~200 ms preconfirmations.

**The honesty boundary.** We have no users, revenue, or traction yet. The market argument above is qualitative and structural. If the reviewer wants market-size figures, we will include them only with a citable source: `[FILL: market size figure with source, if the applicant chooses to include one]`.

---

### 4.5 Kapasitas tim (팀 구성 역량) / Team capability

#### ID

> **PERINGATAN: SELURUH SUBSEKSI INI ADALAH PLACEHOLDER DAN HARUS DIISI PEMOHON SECARA PRIBADI.**
> Tidak ada nama, peran, riwayat, atau pencapaian yang dikarang di sini. Jangan submit dalam keadaan ini.

**Komposisi tim.**

| Nama | Peran | Komitmen waktu | Lokasi / zona waktu | GitHub / X | Pekerjaan relevan yang pernah dirilis |
|---|---|---|---|---|---|
| `[ISI: nama]` | `[ISI: peran, mis. kontrak, TypeScript, produk]` | `[ISI: penuh waktu / paruh waktu, jam per minggu]` | `[ISI]` | `[ISI: tautan]` | `[ISI: nama proyek, tautan, apa yang dikerjakan]` |
| `[ISI: tambah baris sesuai jumlah anggota]` | | | | | |

**Ukuran tim:** `[ISI: jumlah anggota]`.

**Mengapa tim ini mampu mengerjakan proyek ini:** `[ISI: 3–5 kalimat. Sebutkan hanya yang dapat diverifikasi — kontrak yang pernah di-deploy dan alamatnya, paket yang pernah dipublikasikan, produk yang pernah dirilis, pengalaman Solidity/TypeScript/MCP, hackathon yang pernah diikuti beserta hasilnya.]`

**Bukti eksekusi pada proyek ini:** `[ISI: tautan repo publik]`, `[ISI: tautan commit atau riwayat kontribusi]`, `[ISI: alamat kontrak terverifikasi]`.

**Kesenjangan yang kami sadari dan rencana menutupnya:** `[ISI: mis. desain UI, pengembangan bisnis, audit keamanan — dan bagaimana rencananya diatasi]`

**Rencana rekrutmen jika terpilih:** `[ISI: peran yang akan ditambahkan, atau nyatakan tidak ada]`

#### EN

> **WARNING: THIS ENTIRE SUBSECTION IS A PLACEHOLDER AND MUST BE FILLED IN PERSONALLY BY THE APPLICANT.**
> No names, roles, histories, or achievements are invented here. Do not submit in this state.

**Team composition.**

| Name | Role | Time commitment | Location / timezone | GitHub / X | Relevant shipped work |
|---|---|---|---|---|---|
| `[FILL: name]` | `[FILL: role, e.g. contracts, TypeScript, product]` | `[FILL: full-time / part-time, hours per week]` | `[FILL]` | `[FILL: link]` | `[FILL: project name, link, what you did]` |
| `[FILL: add rows to match team size]` | | | | | |

**Team size:** `[FILL: number of members]`.

**Why this team can execute this project:** `[FILL: 3-5 sentences. State only what is verifiable — contracts deployed and their addresses, packages published, products shipped, Solidity/TypeScript/MCP experience, hackathons entered and their outcomes.]`

**Evidence of execution on this project:** `[FILL: public repo link]`, `[FILL: commit or contribution history link]`, `[FILL: verified contract addresses]`.

**Gaps we are aware of and how we plan to close them:** `[FILL: e.g. UI design, business development, security audit — and the plan for each]`

**Hiring plan if selected:** `[FILL: roles to add, or state none]`

---

### 4.6 Potensi tertanam di GIWA Wallet (GIWA 월렛 내 탑재 가능성) / Potential to be embedded in GIWA Wallet

#### ID

Ini bukan klaim yang kami tambahkan belakangan. Ini adalah batasan desain yang kami tetapkan sejak awal dan tercatat sebagai persyaratan produk.

**Seluruh permukaan pemilik dana muat dalam satu layar.** Yang perlu ditampilkan sebuah dompet hanyalah satu kartu permintaan yang berisi: agent mana yang meminta (kunci sesi), jumlah dan token, alamat merchant, masa berlaku, alasan permintaan berada di luar *policy*, dan saldo tersedia setelah permintaan disetujui. Di bawahnya dua tombol: setujui atau tolak.

**Maksimal dua interaksi.** Persyaratan produk kami menetapkan bahwa pemilik dana harus dapat menyetujui atau menolak dalam paling banyak dua interaksi. Persyaratan itu ada justru karena alur yang butuh lebih dari dua langkah tidak layak ditanam di dalam dompet.

**Primitifnya sudah dimiliki dompet mana pun.** Menyetujui berarti menandatangani struct EIP-712 lalu mengirim satu transaksi. Tidak ada yang eksotis: tidak ada kustodi, tidak ada kunci milik kami di dalam dompet, tidak ada sesi jangka panjang yang harus dijaga dompet. Jika sebuah dompet sudah bisa menandatangani EIP-712 dan mengirim transaksi, ia sudah bisa menjalankan seluruh alur persetujuan GiwaCard.

**Tanpa kebutuhan indexer.** Status kartu, saldo, dan escrow dibaca dari satu kontrak. Riwayat dibangun dari event vault. Dompet tidak perlu menjalankan atau berlangganan infrastruktur pengindeksan apa pun untuk menampilkan state yang benar.

**Persetujuan terlepas dari sesi agent.** Antrean persetujuan tidak bergantung pada sesi agent yang masih hidup: pemilik dana boleh menyetujui satu jam kemudian, dan kartu tetap tercetak; agent menemukannya lewat pemeriksaan status yang *stateless*. Ini penting untuk dompet mobile, karena pengguna dompet tidak mungkin diharuskan menyetujui dalam hitungan detik sementara terminalnya menunggu.

**Bentuk integrasi yang kami usulkan.** Sebuah tab "Agent Requests" di dalam GIWA Wallet yang menampilkan antrean permintaan; tautan dalam (*deep link*) dari CLI dan dasbor ke layar tersebut; dan, pada tahap berikutnya, penampilan agent peminta dan merchant dengan nama up.id alih-alih alamat heksadesimal. Kami bersedia menyesuaikan bentuknya dengan pedoman integrasi tim GIWA Wallet — permintaan kontak teknis untuk ini ada di Seksi 8.

#### EN

This is not a claim added after the fact. It is a design constraint we set at the start and recorded as a product requirement.

**The entire owner surface fits on one screen.** All a wallet needs to render is one request card containing: which agent asked (session key), amount and token, merchant address, expiry, why the request fell outside policy, and the available balance after approval. Below it, two buttons: approve or deny.

**At most two interactions.** Our product requirements state that the owner must be able to approve or deny in at most two interactions. That requirement exists precisely because a flow needing more than two steps does not belong inside a wallet.

**The primitive is one every wallet already has.** Approving means signing an EIP-712 struct and sending one transaction. Nothing exotic: no custody, no keys of ours inside the wallet, no long-lived session for the wallet to maintain. If a wallet can already sign EIP-712 and send a transaction, it can already run the entire GiwaCard approval flow.

**No indexer required.** Card status, balance, and escrow are read from a single contract. History is reconstructed from vault events. The wallet does not need to run or subscribe to any indexing infrastructure to display correct state.

**Approval is decoupled from the agent session.** The approval queue does not depend on a live agent session: the owner may approve an hour later and the card still mints; the agent discovers it through a stateless status check. This matters for a mobile wallet, because a wallet user cannot be required to approve within seconds while a terminal waits.

**The integration shape we propose.** An "Agent Requests" tab inside GIWA Wallet showing the request queue; deep links from the CLI and dashboard into that screen; and, in a later stage, rendering the requesting agent and the merchant with up.id names instead of hex addresses. We are willing to adapt the shape to the GIWA Wallet team's integration guidelines — the request for a technical contact for this is in Section 8.

---

## 5. Alasan mendaftar dua track / Two-track application rationale

#### ID

Program mengizinkan pendaftaran di lebih dari satu track, dengan maksimum tiga tim per track. Kami mendaftar di dua.

**AI/WEB3 — track utama.** Ini adalah identitas produk. GiwaCard bukan aplikasi yang kebetulan memakai AI; produk ini adalah infrastruktur yang keberadaannya hanya masuk akal karena agent otonom membelanjakan uang. Permukaan utamanya adalah MCP server dan Agent Skill, dan ancaman yang ditanganinya — kesalahan model dan *prompt injection* — adalah ancaman khas AI. Kalau agent tidak ada, produk ini tidak ada.

**GIWA-NATIVE IDEAS — track sekunder.** Kami mendaftar di sini karena fitur GIWA yang kami pakai bersifat menopang, bukan hiasan. Flashblocks menentukan apakah pembayaran agent bisa dirancang sinkron; predeploy genesis menentukan berapa banyak infrastruktur yang tidak perlu kami bangun; jalur integrasi GIWA Wallet adalah bagian dari desain permukaan persetujuan sejak awal; up.id memberi jalur reputasi merchant yang tidak tersedia di chain lain. Ide ini lahir dari properti GIWA, dan tidak akan sama bentuknya jika dipindahkan ke chain lain.

**Kami tidak mendaftar** di DEFI/RWA, CONSUMER/SOCIAL, atau MASS ADOPTION. Produk ini bukan protokol DeFi, bukan aplikasi konsumen, dan pada tahap ini menyasar pengembang, bukan pengguna massal. Mendaftar di sana akan menjadi klaim yang tidak jujur.

#### EN

The program allows applying to more than one track, with a maximum of three teams per track. We apply to two.

**AI/WEB3 — primary track.** This is the product's identity. GiwaCard is not an application that happens to use AI; it is infrastructure whose existence only makes sense because autonomous agents spend money. Its primary surface is an MCP server and an Agent Skill, and the threats it addresses — model error and prompt injection — are AI-specific threats. If agents did not exist, this product would not exist.

**GIWA-NATIVE IDEAS — secondary track.** We apply here because the GIWA features we use are load-bearing, not decorative. Flashblocks determine whether agent payment can be designed synchronously; the genesis predeploys determine how much infrastructure we do not have to build; the GIWA Wallet integration path shaped the approval surface from the start; up.id offers a merchant-reputation path unavailable on other chains. This idea grew out of GIWA's properties and would not have the same shape if moved elsewhere.

**We are not applying** to DEFI/RWA, CONSUMER/SOCIAL, or MASS ADOPTION. This product is not a DeFi protocol, not a consumer application, and at this stage it targets developers rather than mass users. Applying there would be a dishonest claim.

---

## 6. Peta jalan yang dipetakan ke fase program / Roadmap mapped to the program phases

#### ID

**Catatan waktu masuk.** Kami mendaftar setelah tenggat perpanjangan 31 Juli 2026, mengandalkan pernyataan halaman program bahwa aplikasi baru diterima selama Phase 2. Artinya kami masuk di tengah siklus dan Phase 2 kami memang lebih padat. Kami menyampaikan itu apa adanya, dan menyusun rencana untuk mengejar, bukan untuk memberi kesan sudah sejajar.

| Fase program | Jadwal program | Yang kami kerjakan | Keluaran yang dapat diperiksa |
|---|---|---|---|
| Phase 1 — seleksi | Mei 2026 | Aplikasi ini; kontrak inti sudah ter-deploy dan terverifikasi di GIWA Sepolia; jalur pembayaran agent sudah berjalan | Alamat kontrak terverifikasi; transaksi mint dan charge di explorer; repo publik |
| Phase 2 — bangun MVP | Jun–Jul 2026 | Selesaikan MVP: MCP server dan Agent Skill, wizard CLI, daemon antrean persetujuan, merchant API berbayar, stablecoin uji + faucet | `npx giwacard` menjalankan onboarding sampai kartu pertama; demo E2E berjalan tanpa intervensi selain persetujuan pemilik |
| Phase 3 — produktisasi | Agu–Sep 2026 | Dasbor dengan kualitas UI/UX yang layak dipakai; onboarding coding agent di bawah 10 menit; publikasi paket npm; dokumentasi dua jalur (untuk manusia / untuk agent); pengguna awal dan umpan baliknya | Paket publik di registry; catatan hasil uji onboarding; jumlah pengguna awal beserta metodenya |
| Demoday | Oktober 2026, Korea Blockchain Week | Demo langsung: agent membayar API berbayar di GIWA, persetujuan di luar *policy* diputuskan langsung di panggung, dan percobaan *prompt injection* yang tetap ditolak kontrak | Demo langsung + video + repo publik + paket terpasang dari registry dalam satu perintah |
| Phase 4 — pertumbuhan | Setelah Demoday, digerakkan KPI | Penerbitan B2B multi-tenant (organisasi menerbitkan kartu untuk agent penggunanya); peluncuran mainnet saat mainnet GIWA tersedia; integrasi GIWA Wallet; up.id untuk merchant dan agent; kompatibilitas ERC-4337 memakai EntryPoint genesis; sponsor gas lewat paymaster | KPI di Seksi 7 |

**Tiga item terbesar di Phase 4, secara ringkas.**

- **Penerbitan B2B multi-tenant.** Hari ini satu pemilik dana mengelola agent-nya sendiri. Bentuk komersialnya adalah organisasi yang menerbitkan kartu bercakupan untuk agent milik penggunanya, dengan *policy* bertingkat dan pelaporan. Ini adalah perluasan dari model vault yang sama, bukan produk baru.
- **Peluncuran mainnet.** Menunggu mainnet GIWA. Prasyarat yang sudah kami tetapkan sendiri: kepemilikan upgrade dipindahkan ke multisig dengan *timelock*, dan audit keamanan `[ISI: rencana audit — mandiri, hibah, atau lewat program]`.
- **Integrasi GIWA Wallet.** Sesuai bentuk di 4.6, mengikuti pedoman tim GIWA Wallet.

#### EN

**A note on our entry timing.** We are applying after the 31 July 2026 extended deadline, relying on the program page's statement that new applications are accepted during Phase 2. That means we enter mid-cycle and our Phase 2 is genuinely compressed. We state that plainly, and plan to catch up rather than to appear already level.

| Program phase | Program schedule | What we do | Inspectable output |
|---|---|---|---|
| Phase 1 — screening | May 2026 | This application; core contracts already deployed and verified on GIWA Sepolia; agent payment path already working | Verified contract addresses; mint and charge transactions on the explorer; public repo |
| Phase 2 — MVP build | Jun–Jul 2026 | Complete the MVP: MCP server and Agent Skill, CLI wizard, approval-queue daemon, paid merchant API, test stablecoin + faucet | `npx giwacard` runs onboarding through to the first card; E2E demo runs with no intervention beyond owner approval |
| Phase 3 — productize | Aug–Sep 2026 | Dashboard at a UI/UX quality fit for real use; sub-10-minute coding-agent onboarding; npm package publication; two-path documentation (for humans / for agents); first users and their feedback | Public package in the registry; onboarding test records; first-user count with the counting method stated |
| Demoday | October 2026, Korea Blockchain Week | Live demo: an agent pays a paid API on GIWA, an out-of-policy approval resolved live on stage, and a prompt-injection attempt that the contract still rejects | Live demo + video + public repo + one-command install from the registry |
| Phase 4 — growth | Post-Demoday, KPI-driven | B2B multi-tenant issuing (organizations issuing cards for their users' agents); mainnet launch once GIWA mainnet is available; GIWA Wallet integration; up.id for merchants and agents; ERC-4337 compatibility using the genesis EntryPoint; gas sponsorship via a paymaster | KPIs in Section 7 |

**The three largest Phase 4 items, briefly.**

- **B2B multi-tenant issuing.** Today a single owner manages their own agents. The commercial shape is an organization issuing scoped cards for its users' agents, with tiered policy and reporting. This is an extension of the same vault model, not a new product.
- **Mainnet launch.** Waiting on GIWA mainnet. Prerequisites we have already imposed on ourselves: upgrade ownership moved to a multisig with a timelock, and a security audit `[FILL: audit plan — self-funded, grant-funded, or through the program]`.
- **GIWA Wallet integration.** In the shape described in 4.6, following the GIWA Wallet team's guidelines.

---

## 7. Usulan KPI untuk tingkat bonus / KPI proposal for the bonus grant tier

#### ID

**Prinsip.** Bonus terikat pada volume transaksi, TVL, dan akuisisi pengguna. Kami menyampaikan satu hal secara langsung: selama mainnet GIWA belum tersedia, TVL dan volume transaksi bernilai uang nyata bukan metrik yang jujur untuk produk ini. Karena itu kami mengusulkan dua set KPI — set testnet yang berlaku sampai mainnet, dan set mainnet yang menggantikannya sejak hari peluncuran mainnet. Semua angka di bawah adalah **target yang kami usulkan dan siap dinegosiasikan**, bukan pencapaian. Kami belum punya pengguna.

**Set A — sampai peluncuran mainnet GIWA.**

| Metrik | Definisi tepat | Sumber pengukuran | Target yang diusulkan |
|---|---|---|---|
| Pembayaran yang diinisiasi agent | Jumlah event `Charged` yang sukses di `CardVault` | Log event onchain, dapat direproduksi siapa pun | `[ISI: mis. 1.000 dalam 90 hari setelah Demoday]` |
| Dompet pemilik aktif | Alamat pemilik unik dengan ≥1 kartu tercetak dalam 30 hari berjalan | Event `Minted` onchain | `[ISI: mis. 50]` |
| Vault terdanai | Alamat pemilik unik dengan saldo setoran > 0 | State onchain | `[ISI: mis. 100]` |
| Host agent terintegrasi | Jumlah host MCP berbeda yang lolos runbook instalasi kami (mis. Claude Code, Cursor, Gemini CLI) | Catatan uji yang direproduksi ulang | `[ISI: mis. 3]` |
| Endpoint merchant | Jumlah endpoint berbayar pihak ketiga yang menerima settlement GiwaCard | Daftar publik + tx verifikasi | `[ISI: mis. 3]` |
| Unduhan paket | Unduhan mingguan `giwacard` di registry npm | Statistik registry publik | `[ISI: mis. 200/minggu]` |
| Waktu onboarding | Waktu bagi coding agent yang belum pernah melihat proyek ini untuk mencapai kartu pertama | Uji onboarding terekam | < 10 menit |
| Latensi permintaan-ke-respons | Waktu median dari permintaan agent sampai respons merchant, memanfaatkan *preconfirmation* | Instrumentasi klien, dilaporkan dengan distribusinya | `[ISI: mis. < 1,5 detik median]` |

**Set B — berlaku sejak mainnet GIWA tersedia.**

| Metrik | Definisi tepat | Sumber pengukuran | Target yang diusulkan |
|---|---|---|---|
| Volume transaksi | Total nilai yang tertagih lewat `CardVault.charge` di mainnet | Log event onchain | `[ISI: target 90 hari]` |
| TVL | Saldo setoran ditambah escrow yang tertahan di `CardVault` | State onchain | `[ISI: target 90 hari]` |
| Akuisisi pengguna | Alamat pemilik unik yang mendanai vault di mainnet | State onchain | `[ISI: target 90 hari]` |
| Pelanggan B2B | Organisasi yang menerbitkan kartu untuk agent penggunanya | Kontrak/perjanjian, dilaporkan terpisah | `[ISI]` |

**Catatan integritas metrik.** Semua metrik Set A dan Set B kecuali unduhan paket dan pelanggan B2B dapat diverifikasi langsung dari state dan event onchain — pihak ketiga dapat menghitung ulang tanpa memercayai kami. Kami akan menerbitkan skrip perhitungan bersama laporannya. Untuk mencegah metrik yang digelembungkan sendiri, kami mengusulkan agar dompet dan alamat milik tim dikecualikan dari perhitungan dan didaftarkan di muka.

#### EN

**Principle.** The bonus is tied to transaction volume, TVL, and user acquisition. We will say one thing directly: while GIWA mainnet is not yet available, TVL and real-value transaction volume are not honest metrics for this product. So we propose two KPI sets — a testnet set that applies until mainnet, and a mainnet set that replaces it from mainnet launch day. Every number below is a **target we are proposing and are willing to negotiate**, not an achievement. We have no users yet.

**Set A — until GIWA mainnet launch.**

| Metric | Precise definition | Measurement source | Proposed target |
|---|---|---|---|
| Agent-initiated payments | Count of successful `Charged` events on `CardVault` | Onchain event logs, reproducible by anyone | `[FILL: e.g. 1,000 within 90 days of Demoday]` |
| Active owner wallets | Unique owner addresses with ≥1 card minted in a rolling 30 days | Onchain `Minted` events | `[FILL: e.g. 50]` |
| Funded vaults | Unique owner addresses with deposit balance > 0 | Onchain state | `[FILL: e.g. 100]` |
| Integrated agent hosts | Number of distinct MCP hosts that pass our install runbook (e.g. Claude Code, Cursor, Gemini CLI) | Reproduced test records | `[FILL: e.g. 3]` |
| Merchant endpoints | Number of third-party paid endpoints accepting GiwaCard settlement | Public list + verification transactions | `[FILL: e.g. 3]` |
| Package downloads | Weekly downloads of `giwacard` on the npm registry | Public registry statistics | `[FILL: e.g. 200/week]` |
| Onboarding time | Time for a coding agent that has never seen this project to reach its first card | Recorded onboarding test | < 10 minutes |
| Request-to-response latency | Median time from agent request to merchant response, using preconfirmations | Client instrumentation, reported with distribution | `[FILL: e.g. < 1.5 s median]` |

**Set B — effective once GIWA mainnet is available.**

| Metric | Precise definition | Measurement source | Proposed target |
|---|---|---|---|
| Transaction volume | Total value charged through `CardVault.charge` on mainnet | Onchain event logs | `[FILL: 90-day target]` |
| TVL | Deposit balance plus escrow held in `CardVault` | Onchain state | `[FILL: 90-day target]` |
| User acquisition | Unique owner addresses funding a vault on mainnet | Onchain state | `[FILL: 90-day target]` |
| B2B customers | Organizations issuing cards for their users' agents | Contracts/agreements, reported separately | `[FILL]` |

**A note on metric integrity.** Every Set A and Set B metric except package downloads and B2B customers is verifiable directly from onchain state and events — a third party can recompute them without trusting us. We will publish the computation scripts alongside the reports. To prevent self-inflated metrics, we propose that team-owned wallets and addresses be excluded from the counts and registered in advance.

---

## 8. Yang kami minta / What we are asking for

#### ID

**Dari struktur hibah program.**

- Hibah awal sekitar US$20.000 setelah menyelesaikan program. Digunakan untuk `[ISI: alokasi — mis. waktu pengembang, audit keamanan, infrastruktur RPC/hosting, biaya Demoday]`.
- Kelayakan untuk tingkat bonus hingga US$80.000 yang terikat KPI, dengan KPI yang diusulkan di Seksi 7 dan siap dinegosiasikan.
- Pertimbangan untuk pencantuman di dalam aplikasi GIWA Wallet, dengan bentuk integrasi seperti dijelaskan di 4.6.
- Perkenalan kepada VC papan atas, bila tim dinilai siap untuk itu.

Kami memahami bahwa hibah bersifat kena pajak dan kami memperhitungkannya dalam perencanaan kami; `[ISI: konfirmasi bagaimana pemohon menangani kewajiban pajak di yurisdiksinya]`.

**Dukungan non-finansial yang justru paling menentukan bagi produk ini.**

1. **Akses RPC yang andal.** RPC publik GIWA Sepolia bersifat *rate-limited* dan dinyatakan hanya untuk pengembangan. Sebuah endpoint dengan batas yang dinaikkan, atau kunci API yang di-*allowlist*, akan sangat menurunkan risiko demo langsung dan pengujian beban.
2. **Kuota faucet yang lebih besar untuk dompet demo.** Batas 0,005–0,01 ETH per 24 jam membatasi jumlah dompet demo yang dapat kami jalankan sekaligus. Alokasi khusus untuk beberapa alamat demo sudah cukup.
3. **Kontak teknis untuk integrasi GIWA Wallet.** Kami ingin menyelaraskan bentuk permukaan persetujuan dengan pedoman tim GIWA Wallet sedini mungkin, bukan sesudah dibangun.
4. **Kejelasan jadwal mainnet GIWA.** Peluncuran mainnet kami dan set KPI Set B bergantung padanya.
5. **Umpan balik atas skema settlement.** Kami memilih menyimpang dari x402 `exact_evm` karena alasan teknis di 4.2. Masukan dari tim GIWA akan kami terima, terutama jika ada arah interoperabilitas yang ingin didorong di ekosistem.
6. **Konfirmasi kelayakan aplikasi.** Kami mendaftar setelah tenggat perpanjangan 31 Juli 2026, mengandalkan pernyataan halaman program bahwa aplikasi baru diterima selama Phase 2. Kami meminta konfirmasi eksplisit bahwa aplikasi ini akan ditinjau, dan jika tidak, kami meminta arahan mengenai siklus berikutnya.

#### EN

**From the program's grant structure.**

- The initial grant of approximately $20,000 on completing the program. To be used for `[FILL: allocation — e.g. developer time, security audit, RPC/hosting infrastructure, Demoday costs]`.
- Eligibility for the KPI-linked bonus tier of up to $80,000, with the KPIs proposed in Section 7 and open to negotiation.
- Consideration for in-app listing in GIWA Wallet, in the integration shape described in 4.6.
- Introductions to top-tier VCs, if the team is judged ready for that.

We understand the grants are taxable and account for that in our planning; `[FILL: confirm how the applicant handles the tax obligation in their jurisdiction]`.

**Non-financial support, which for this product matters most.**

1. **Reliable RPC access.** The GIWA Sepolia public RPC is rate-limited and documented as development-only. An endpoint with raised limits, or an allowlisted API key, would substantially de-risk live demos and load testing.
2. **A larger faucet allowance for demo wallets.** The 0.005–0.01 ETH per 24 hours cap limits how many demo wallets we can run at once. A dedicated allocation for a handful of demo addresses would be enough.
3. **A technical contact for GIWA Wallet integration.** We want to align the approval surface with the GIWA Wallet team's guidelines as early as possible, not after it is built.
4. **Clarity on the GIWA mainnet timeline.** Our mainnet launch and the Set B KPIs depend on it.
5. **Feedback on our settlement scheme.** We chose to diverge from x402 `exact_evm` for the technical reason given in 4.2. We would welcome input from the GIWA team, particularly if there is an interoperability direction the ecosystem wants to push.
6. **Confirmation of application eligibility.** We are applying after the 31 July 2026 extended deadline, relying on the program page's statement that new applications are accepted during Phase 2. We ask for explicit confirmation that this application will be reviewed, and if not, guidance on the next cycle.

---

## Lampiran A — Klaim teknis dan cara memverifikasinya / Appendix A — Technical claims and how to verify them

**ID.** Tabel ini ada agar reviewer dapat memeriksa sendiri setiap klaim teknis di dokumen ini tanpa memercayai kami. Baris yang berisi placeholder harus dilengkapi pemohon sebelum submit. / **EN.** This table exists so a reviewer can check every technical claim in this document without trusting us. Rows containing placeholders must be completed by the applicant before submission.

| Klaim / Claim | Verifikasi / How to verify |
|---|---|
| GIWA adalah L2 OP Stack, EVM-equivalent / GIWA is an OP Stack, EVM-equivalent L2 | https://docs.giwa.io |
| GIWA Sepolia chain ID 91342 | https://docs.giwa.io — halaman connect-to-giwa |
| Predeploy genesis: EntryPoint ERC-4337 v0.6 dan v0.7, Safe, Permit2, Multicall3 | https://docs.giwa.io — halaman contracts; alamat predeploy dapat dibuka langsung di explorer |
| Flashblocks ~200 ms preconfirmation; interval blok 1 detik | https://docs.giwa.io — halaman flashblocks |
| RPC publik *rate-limited* dan hanya untuk pengembangan | https://docs.giwa.io — halaman connect-to-giwa |
| Faucet 0,005–0,01 ETH per 24 jam | https://docs.giwa.io — halaman faucets |
| up.id terverifikasi KYC dan *soul-bound* | https://docs.giwa.io — halaman up.id |
| Mainnet GIWA masih dalam pengembangan | https://docs.giwa.io |
| Struktur hibah, track, kriteria seleksi, dan jadwal GASOK | https://giwa.io/gasok |
| `CardVault` ter-deploy dan terverifikasi | `[ISI / FILL: https://sepolia-explorer.giwa.io/address/...]` |
| `gUSD` ter-deploy dan terverifikasi | `[ISI / FILL: https://sepolia-explorer.giwa.io/address/...]` |
| Transaksi mint kartu dan charge yang sukses | `[ISI / FILL: tautan transaksi]` |
| Kode sumber lengkap, lisensi, dan atribusi MIT | `[ISI / FILL: URL repo publik]` + berkas `NOTICE` di dalamnya |
| Kami menggunakan kembali kode MIT dari repositori publik agentcard.sh dengan atribusi | Berkas `NOTICE` di repo kami + berkas `LICENSE` di repositori hulu |
| Kami tidak berafiliasi dengan agentcard.sh maupun akselerator mana pun | Tidak ada klaim afiliasi yang dibuat di dokumen ini; tidak ada klaim seperti itu yang boleh ditambahkan |

---

## 9. TODO — yang harus disediakan pemohon sebelum submit / TODO — what the applicant must supply before submitting

> **ID.** Dokumen ini **tidak boleh disubmit** sebelum seluruh kotak di bawah tercentang dan seluruh `[ISI: ...]` serta `[FILL: ...]` di dokumen ini hilang.
> **EN.** This document **must not be submitted** until every box below is checked and every `[ISI: ...]` and `[FILL: ...]` in this document is gone.

**Tim dan identitas / Team and identity**

- [ ] Nama lengkap, peran, dan komitmen waktu setiap anggota tim (Seksi 4.5) / Full name, role, and time commitment for each team member (Section 4.5)
- [ ] Ukuran tim / Team size
- [ ] Tautan GitHub dan X/Twitter setiap anggota / GitHub and X/Twitter links for each member
- [ ] Pekerjaan relevan yang pernah dirilis, dengan tautan yang dapat diverifikasi — tidak boleh dikarang / Relevant shipped work with verifiable links — must not be invented
- [ ] Paragraf "mengapa tim ini" / The "why this team" paragraph
- [ ] Kesenjangan kemampuan dan rencana menutupnya / Capability gaps and the plan to close them
- [ ] Rencana rekrutmen jika terpilih, atau pernyataan tidak ada / Hiring plan if selected, or a statement that there is none
- [ ] Nama entitas hukum jika ada, dan negara pendirian / Legal entity name if any, and country of incorporation
- [ ] Bagaimana kewajiban pajak atas hibah ditangani (Seksi 8) / How the tax obligation on the grant is handled (Section 8)

**Kontak / Contact**

- [ ] Alamat email utama untuk aplikasi / Primary email address for the application
- [ ] Kontak cadangan (Telegram/Discord/KakaoTalk sesuai preferensi tim GIWA) / Backup contact (Telegram/Discord/KakaoTalk per the GIWA team's preference)
- [ ] Zona waktu dan jam yang tersedia untuk wawancara / Timezone and availability for interviews

**Tautan dan artefak / Links and artifacts**

- [ ] URL repositori publik / Public repository URL
- [ ] Alamat `CardVault` dan `gUSD` yang ter-deploy, ditambah tautan explorer yang menunjukkan status Verified / Deployed `CardVault` and `gUSD` addresses, plus explorer links showing Verified status
- [ ] Tautan transaksi mint dan charge contoh / Example mint and charge transaction links
- [ ] Landing page atau situs proyek, jika sudah ada / Landing page or project site, if one exists
- [ ] Nama paket npm dan status publikasinya / npm package name and publication status
- [ ] Daftar komponen yang belum rampung per tanggal submit (Seksi 4.3) — harus akurat / List of components not yet complete as of the submission date (Section 4.3) — must be accurate

**Materi demo / Demo material**

- [ ] Video demo (rekaman layar): onboarding → agent membayar API berbayar → persetujuan di luar policy → kartu hangus / Demo video (screen recording): onboarding → agent pays the paid API → out-of-policy approval → card goes void
- [ ] Tautan video yang dapat diakses publik dan tidak kedaluwarsa / Publicly accessible, non-expiring video link
- [ ] Slide deck jika form memintanya / Slide deck if the form asks for one

**Angka dan target / Numbers and targets**

- [ ] Target KPI Set A (Seksi 7) — putuskan angka yang berani tetapi dapat dipertanggungjawabkan / Set A KPI targets (Section 7) — pick numbers that are ambitious but defensible
- [ ] Target KPI Set B (Seksi 7) / Set B KPI targets (Section 7)
- [ ] Alokasi penggunaan hibah US$20.000 (Seksi 8) / Allocation of the $20,000 grant (Section 8)
- [ ] Rencana audit keamanan sebelum mainnet (Seksi 6) / Pre-mainnet security audit plan (Section 6)
- [ ] Angka ukuran pasar dengan sumber, jika ingin disertakan (Seksi 4.4) — hanya dengan kutipan / Market size figures with sources, if you want to include them (Section 4.4) — only with citations

**Pemeriksaan akhir sebelum submit / Final checks before submitting**

- [ ] Cari seluruh dokumen untuk `[ISI:` dan `[FILL:` — harus nol hasil / Search the whole document for `[ISI:` and `[FILL:` — must return zero results
- [ ] Pastikan tidak ada klaim afiliasi dengan Y Combinator, agentcard.sh, atau akselerator mana pun / Confirm there is no claim of affiliation with Y Combinator, agentcard.sh, or any accelerator
- [ ] Pastikan tidak ada angka pengguna, pendapatan, atau traksi yang tidak dapat dibuktikan / Confirm there are no user, revenue, or traction numbers that cannot be evidenced
- [ ] Pastikan setiap alamat kontrak di dokumen benar-benar menunjukkan Verified di explorer / Confirm every contract address in the document really shows Verified on the explorer
- [ ] Konfirmasi kelayakan aplikasi ke pihak GIWA lewat kontak resmi di halaman GASOK sebelum atau bersamaan dengan submit / Confirm application eligibility with GIWA via the official contact on the GASOK page, before or alongside submitting
- [ ] Putuskan bahasa submit (Inggris atau Korea) dan siapkan terjemahan jika form meminta Korea / Decide the submission language (English or Korean) and prepare a translation if the form requires Korean
