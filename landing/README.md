# PieFlow landing page

Static, SEO-optimized marketing site for PieFlow. No build step, no framework.

## Deploy to Vercel

1. Push this repo to GitHub (already done).
2. In Vercel, "New Project" and import the repo.
3. Set the **Root Directory** to `landing`. Framework preset: "Other". No build command; output is the folder itself.
4. Deploy. Add your custom domain in Vercel's Domains settings.

Or from the CLI, inside this folder:

```
npx vercel --prod
```

## Before launch, update these

- `index.html`: the `og:image`, `canonical`, and `twitter` URLs use `https://pieflow.app/`. Change them to your real domain.
- `sitemap.xml` and `robots.txt`: same domain.
- The **Get Pro** button links to `https://pieflow.lemonsqueezy.com/buy/REPLACE-WITH-VARIANT`. Replace with your real Lemon Squeezy (or Paddle) checkout URL.
- Download buttons point to the GitHub releases page, which always serves the latest installer. No change needed.

Assets (screenshots, fonts, OG image) live in `assets/` and `fonts/` and are all self-hosted, so the page has no external dependencies.
