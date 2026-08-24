import type { MonitorConfig } from "@socialmonitor/shared";

/**
 * Starter monitor templates (Tier 1): canned configs that collapse the
 * cold-start cost of writing taxonomy/noise-rules/seed-examples from scratch.
 * Placeholders in [BRACKETS] are meant to be edited on the settings page.
 */
export interface MonitorTemplate {
  key: string;
  title: string;
  description: string;
  config: Partial<MonitorConfig>;
}

export const MONITOR_TEMPLATES: MonitorTemplate[] = [
  {
    key: "blank",
    title: "Blank",
    description: "Empty config — you write the taxonomy and rules yourself.",
    config: {},
  },
  {
    key: "brand",
    title: "Brand watch",
    description: "Your own product: complaints, feature requests, praise, support signals.",
    config: {
      context:
        "Monitoring public feedback about [YOUR PRODUCT], a [ONE-LINE DESCRIPTION]. " +
        "We care about real user experiences: bugs, feature requests, praise, support pain, " +
        "and outage reports. We do not care about price/market speculation or engagement bait.",
      tags: [
        { name: "Product Quality", hint: "bugs, broken or degraded behavior in the product itself" },
        { name: "Feature Gaps", hint: "requests for capabilities that do not exist yet" },
        { name: "Support Experience", hint: "the support EXPERIENCE (slow, unhelpful) - not every item arriving via support" },
        { name: "Reliability & Outages", hint: "the service down or degraded - NOT one failed action with an ordinary cause" },
        { name: "Pricing", hint: "cost, plans, billing complaints or comparisons" },
        { name: "General", hint: "LAST RESORT ONLY - never alongside another tag." },
      ],
      noise_rules:
        "- Mentions where [YOUR PRODUCT] is tangential (main topic is something else)\n" +
        "- Engagement-farming posts, giveaways, follow-to-win\n" +
        "- Job postings and recruiter posts\n" +
        "- Posts about unrelated products sharing the name",
      seed_examples: [
        { text: "[product] keeps crashing when I open settings, third time this week", relevant: true, signal_type: "complaint", tags: ["Product Quality"], why: "specific reproducible bug report" },
        { text: "wish [product] could export to CSV, PDF-only is useless for us", relevant: true, signal_type: "feature_request", tags: ["Feature Gaps"], why: "concrete capability ask with a reason" },
        { text: "been on [product] six months, genuinely the best tool we've tried", relevant: true, signal_type: "praise", tags: ["General"], why: "explicit praise; General because no specific area is named" },
        { text: "huge GIVEAWAY follow + RT to win!! @[product]", relevant: false, why: "engagement farming, no feedback content" },
        { text: "we're hiring a [product] specialist, DM me", relevant: false, why: "job post, not user signal" },
      ],
    },
  },
  {
    key: "competitor",
    title: "Competitor watch",
    description: "A rival product: their announcements, their users' pain, switching signals.",
    config: {
      context:
        "Monitoring public conversation about [COMPETITOR], a competitor to our product " +
        "[YOUR PRODUCT]. We care about: their announcements and launches, their users' " +
        "complaints (our opportunity), users comparing them to alternatives, and switching " +
        "stories in either direction.",
      tags: [
        { name: "Their Announcements", hint: "official launches, pricing changes, roadmap statements" },
        { name: "Their Users' Pain", hint: "complaints and frustrations from their users" },
        { name: "Comparisons", hint: "head-to-head comparisons with any alternative product" },
        { name: "Switching Signals", hint: "someone moving to or from the competitor" },
        { name: "Pricing Moves", hint: "their cost, plans, discounts" },
        { name: "General", hint: "LAST RESORT ONLY - never alongside another tag." },
      ],
      noise_rules:
        "- Their own marketing being reshared without commentary\n" +
        "- Engagement bait and giveaways\n" +
        "- Posts about unrelated products sharing the name",
      seed_examples: [
        { text: "[competitor] just announced their v3 with realtime collab", relevant: true, signal_type: "announcement", tags: ["Their Announcements"], why: "official launch news - track it" },
        { text: "so done with [competitor], support ghosted us for two weeks", relevant: true, signal_type: "complaint", tags: ["Their Users' Pain", "Switching Signals"], why: "churn-risk complaint; genuinely about both" },
        { text: "comparing [competitor] vs [your product] for our team, thoughts?", relevant: true, signal_type: "question", tags: ["Comparisons"], why: "active evaluation - high-value signal" },
        { text: "RT @[competitor]: check out our new landing page!", relevant: false, why: "their marketing reshared, no third-party signal" },
      ],
    },
  },
  {
    key: "topic",
    title: "Topic watch",
    description: "A theme or narrative: news, expert takes, community sentiment around a subject.",
    config: {
      context:
        "Monitoring conversation about [TOPIC / NARRATIVE]. We care about: news and " +
        "announcements, substantive expert analysis, shifts in community sentiment, and " +
        "recurring questions. We do not care about low-effort hot takes or price-only chatter.",
      tags: [
        { name: "News & Announcements", hint: "new factual developments about the topic" },
        { name: "Expert Analysis", hint: "substantive argued takes from credible voices" },
        { name: "Community Sentiment", hint: "how the crowd feels - mood shifts, dominant opinions" },
        { name: "Open Questions", hint: "recurring questions people keep asking" },
        { name: "General", hint: "LAST RESORT ONLY - never alongside another tag." },
      ],
      noise_rules:
        "- One-line hot takes with no argument\n" +
        "- Pure price/market speculation\n" +
        "- Engagement bait, listicles, thread-bro recycling",
      seed_examples: [
        { text: "[authority] just published new guidance on [topic], key change: ...", relevant: true, signal_type: "news", tags: ["News & Announcements"], why: "factual development from a primary source" },
        { text: "long thread: why [topic] is misunderstood - the data actually shows...", relevant: true, signal_type: "opinion", tags: ["Expert Analysis"], why: "substantive argued analysis" },
        { text: "[topic] to the moon 🚀🚀", relevant: false, why: "content-free hype" },
      ],
    },
  },
];

export function templateConfig(key: string): Partial<MonitorConfig> {
  return MONITOR_TEMPLATES.find((t) => t.key === key)?.config ?? {};
}
