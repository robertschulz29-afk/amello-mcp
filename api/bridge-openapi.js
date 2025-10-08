module.exports = function handler(req, res) {
  const host = `https://${req.headers.host}`;
  const oas = {
    openapi: '3.1.0',
    info: { title: 'Amello Bridge (Direct)', version: '1.0.0' },
    servers: [{ url: host }],
    paths: {
      '/api/bridge/find-hotels': {
        post: {
          operationId: 'findHotels',
          summary: 'Find hotels by region (multiroom)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['destination','departureDate','returnDate','currency','roomConfigurations','locale'],
                  properties: {
                    destination: {
                      type: 'object',
                      required: ['id','type'],
                      properties: { id: { type: 'string' }, type: { type: 'string' } }
                    },
                    departureDate: { type: 'string' },
                    returnDate: { type: 'string' },
                    currency: { type: 'string' },
                    roomConfigurations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['travellers'],
                        properties: {
                          travellers: {
                            type: 'object',
                            required: ['id','adultCount'],
                            properties: {
                              id: { type: 'integer' },
                              adultCount: { type: 'integer' },
                              childrenAges: { type: 'array', items: { type: 'integer' } }
                            }
                          }
                        }
                      }
                    },
                    locale: { type: 'string', enum: ['de_DE','en_DE'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid input' },
            '422': { description: 'Validation error' }
          }
        }
      },
      '/api/bridge/hotel-offer': {
        post: {
          operationId: 'hotelOffer',
          summary: 'Get hotel offers (or framework when roomConfigurations=[])',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hotelId','departureDate','returnDate','currency','roomConfigurations','locale'],
                  properties: {
                    hotelId: { type: 'string' },
                    departureDate: { type: 'string' },
                    returnDate: { type: 'string' },
                    currency: { type: 'string' },
                    roomConfigurations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['travellers'],
                        properties: {
                          travellers: {
                            type: 'object',
                            required: ['id','adultCount'],
                            properties: {
                              id: { type: 'integer' },
                              adultCount: { type: 'integer' },
                              childrenAges: { type: 'array', items: { type: 'integer' } }
                            }
                          }
                        }
                      }
                    },
                    locale: { type: 'string', enum: ['de_DE','en_DE'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Offers/framework', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid input' },
            '422': { description: 'Validation error' }
          }
        }
      },
      '/api/bridge/hotels': {
        get: {
          operationId: 'listHotels',
          summary: 'List hotels',
          parameters: [
            { in: 'query', name: 'locale', required: true, schema: { type: 'string', enum: ['de_DE','en_DE'] } },
            { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1 } }
          ],
          responses: {
            '200': { description: 'Hotel collection', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } }
          }
        }
      },
      '/api/bridge/currencies': {
        get: {
          operationId: 'listCurrencies',
          summary: 'List currencies',
          parameters: [
            { in: 'query', name: 'locale', required: true, schema: { type: 'string', enum: ['de_DE','en_DE'] } }
          ],
          responses: {
            '200': { description: 'Currency collection', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } }
          }
        }
      }
    }
  };

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify(oas, null, 2));
};
