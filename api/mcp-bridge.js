export default async function handler(req, res) {
  const { pathname } = new URL(req.url, `https://${req.headers.host}`);

  // --- /api/mcp-bridge/list ---
  if (pathname.endsWith('/list')) {
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

  // --- /api/mcp-bridge/call ---
  if (pathname.endsWith('/call')) {
    const { name } = req.body || {};

    if (name === 'currencies') {
      const currencies = ['USD', 'EUR', 'GBP', 'JPY'];
      return res.status(200).json({ result: currencies });
    }

    return res.status(400).json({ error: 'Unknown tool' });
  }

  // --- default: not found ---
  return res.status(404).json({ error: 'Not found' });
}
