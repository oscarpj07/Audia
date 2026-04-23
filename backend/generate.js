import Anthropic from '@anthropic-ai/sdk';

export async function generateScript(topic, articles) {
  const client = new Anthropic();

  const articleContext = articles.length > 0
    ? articles.map((a, i) => `[Source ${i + 1}] ${a.title}\n${a.content}`).join('\n\n---\n\n')
    : 'No external sources — use your knowledge on this topic.';

  const prompt = `You are writing a script for an educational podcast with two hosts, ALEX and JAMIE.

TOPIC: "${topic}"

REFERENCE MATERIAL:
${articleContext}

WHO THEY ARE:
- ALEX and JAMIE are two knowledgeable, friendly people who genuinely find this stuff interesting
- They are NOT teachers, NOT professors — they are like two smart friends who have done the research and are now explaining it to YOU (the listener)
- They speak in plain English, no jargon unless they immediately explain it
- They are warm, natural, and occasionally crack a small joke — but they stay on topic

HOW THEY EXPLAIN THINGS:
- They speak DIRECTLY to the listener — "so what you want to do is...", "here's the thing you need to know...", "imagine you're..."
- They use simple analogies to explain complex ideas
- They give real examples with specific details (actual numbers, tool names, steps)
- One host introduces a concept, the other adds a concrete example or a "but here's the important part..."
- They keep sentences short and digestible — no long rambling paragraphs
- They occasionally check in with the listener: "and this is the part most people miss..." or "stick with us here because this is where it gets useful..."

STRUCTURE:
- Open with a hook that tells the listener exactly what they'll walk away knowing
- Cover 4-6 key concepts or steps, building on each other
- Use clear signposting: "okay so the first thing...", "now here's where it gets interesting..."
- Close with a quick recap of the 3 most important things to remember

REQUIREMENTS:
- Aim for 2,500-3,500 words (15-20 minutes)
- Every sentence should either teach something or make the listener want to keep listening
- No debate, no disagreement — they are on the same team explaining the same thing
- Do NOT include stage directions, [music], [pause], or anything that isn't dialogue
- Output ONLY the script lines, nothing else

Format every single line EXACTLY as:
ALEX: [dialogue]
JAMIE: [dialogue]`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: 'You write warm, clear, educational podcast scripts for two hosts who explain topics to the listener in plain English. No jargon, no fluff, no debate. Output only ALEX:/JAMIE: formatted dialogue lines.',
    messages: [{ role: 'user', content: prompt }]
  });

  const script = message.content[0].text.trim();
  const speakerMap = { ALEX: 0, JAMIE: 1 };

  return {
    script,
    format: 'explainer',
    formatLabel: 'Two-Host Explainer',
    speakerMap
  };
}
