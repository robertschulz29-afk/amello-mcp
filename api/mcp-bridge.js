export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname;

  if (path.endsWith('/list')) {
    // Return the available tools
    return res.status(200).json({
      result: {
        tools: [
          { name: 'currencies', description: 'List supported currencies' },
          { name: 'hotels', description: 'Book or search hotels' },
          { name: 'flights', description: 'Find available flights' },
        ],
      },
    });
  }

  if (path.endsWith('/call')) {
    const body = req.body || {};
    const { name, arguments: args } = body;

    if (name === 'currencies') {
      // Example call to your MCP server endpoint
      // Replace this with your real logic if needed
      const currencies = ['USD', 'EUR', 'GBP'];
      return res.status(200).json({ result: currencies });
    }

    return res.status(400).json({ error: 'Unknown tool' });
  }

  // Default: not found
  return res.status(404).json({ error: 'Not found' });
}
