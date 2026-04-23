import axios from 'axios';

export async function searchArticles(topic) {
  const response = await axios.post('https://api.tavily.com/search', {
    api_key: process.env.TAVILY_API_KEY,
    query: topic,
    search_depth: 'advanced',
    max_results: 5,
    include_answer: true,
    include_raw_content: false
  });

  const results = response.data.results || [];
  return results.slice(0, 5).map(r => ({
    title: r.title,
    url: r.url,
    content: r.content?.slice(0, 1500) || ''
  }));
}
