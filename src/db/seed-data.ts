import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { randomToken } from '../lib/crypto';
import { schema, type Db } from './client';

const img = (seed: string) => `https://picsum.photos/seed/${seed}/900/600`;

// Demonstration campaigns. All figures are demo data. Amounts are in cents.
const DEMO = [
  { key: 'air', title: 'Clean Air in School Zones: Particulate Matter Defense', category: 'Environment' as const, creator: 'Dr. Elena Rostova', status: 'funding' as const, goal: 400_000, raised: 342_000, backers: 171,
    summary: 'What air-quality readings around schools show, and what parents can ask their council for.' },
  { key: 'science', title: 'Open Science: Unlocking Rare Pediatric Disease Research', category: 'Science' as const, creator: 'Prof. David Chen', status: 'promoting' as const, goal: 500_000, raised: 500_000, backers: 248,
    summary: 'Why open access to research data matters for families affected by rare diseases.' },
  { key: 'teens', title: 'Teen Mental Health in the Infinite Scroll Era', category: 'Health' as const, creator: 'Amara Washington', status: 'funding' as const, goal: 250_000, raised: 185_000, backers: 98,
    summary: 'What the research does and does not say about teenagers and social media.' },
  { key: 'pollinators', title: 'Protecting Urban Pollinators in Public Parks', category: 'Community' as const, creator: 'Julian Arvaez', status: 'funding' as const, goal: 300_000, raised: 210_000, backers: 119,
    summary: 'A proposal for safer pesticide rules in public parks, and how to support it.' },
  { key: 'finance', title: 'Financial Literacy for High Schoolers', category: 'Education' as const, creator: 'Karina Patel', status: 'funding' as const, goal: 200_000, raised: 40_000, backers: 17,
    summary: 'A short course on budgeting and credit for teenagers, free for schools.' }
];

// Creates the reviewer account and demo campaigns. Safe to run more than once.
export async function seedDemo(db: Db, opts: { adminEmail: string; adminPassword: string; bcryptCost: number }) {
  const adminEmail = opts.adminEmail.toLowerCase();
  const [existingAdmin] = await db.select().from(schema.users).where(eq(schema.users.email, adminEmail)).limit(1);
  if (!existingAdmin) {
    await db.insert(schema.users).values({
      email: adminEmail,
      name: 'Reviewer',
      passwordHash: await bcrypt.hash(opts.adminPassword, opts.bcryptCost),
      role: 'admin'
    });
  }

  // The demo creator cannot sign in: its password is random and thrown away.
  const creatorEmail = 'demo-creator@amplify.local';
  let [creator] = await db.select().from(schema.users).where(eq(schema.users.email, creatorEmail)).limit(1);
  if (!creator) {
    [creator] = await db.insert(schema.users).values({
      email: creatorEmail,
      name: 'Demo Creator',
      passwordHash: await bcrypt.hash(randomToken(), opts.bcryptCost),
      role: 'user'
    }).returning();
  }

  const [already] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.ownerId, creator.id)).limit(1);
  if (already) return { adminCreated: !existingAdmin, campaignsCreated: 0 };

  for (const d of DEMO) {
    const [c] = await db.insert(schema.campaigns).values({
      ownerId: creator.id,
      title: d.title,
      category: d.category,
      creatorName: d.creator,
      summary: d.summary,
      coverImage: img(d.key),
      audienceActionAdvice: 'Share this with someone who may find it useful.',
      adHeadline: d.title.slice(0, 45),
      adDescription: d.summary.slice(0, 90),
      adImage: img(d.key),
      regions: ['India'],
      demographics: 'Adults 18 to 55',
      channels: ['Meta Ads (FB/IG)'],
      goalAmountCents: d.goal,
      raisedAmountCents: d.raised,
      backerCount: d.backers,
      status: d.status,
      adSetupConfirmed: d.status === 'promoting',
      submittedAt: new Date()
    }).returning();
    await db.insert(schema.storyBlocks).values([
      { campaignId: c.id, position: 0, type: 'paragraph', content: d.summary },
      { campaignId: c.id, position: 1, type: 'stat', content: 'Demonstration figure', statValue: '12', statLabel: 'Demo statistic' }
    ]);
    await db.insert(schema.sources).values({
      campaignId: c.id, position: 0, title: 'Demo source', publication: 'Example Journal', url: 'https://example.org/source'
    });
    await db.insert(schema.auditLog).values({
      campaignId: c.id, actorId: null, actorRole: 'system', fromStatus: 'approved', toStatus: d.status === 'promoting' ? 'promoting' : 'funding', note: 'Seeded demo data'
    });
  }
  return { adminCreated: !existingAdmin, campaignsCreated: DEMO.length };
}
