import { XMLParser } from 'fast-xml-parser';

const sources = [
  { name: 'IRNA', url: 'https://www.irna.ir/rss' },
  { name: 'ISNA', url: 'https://www.isna.ir/rss' },
  { name: 'Mehr', url: 'https://www.mehrnews.com/rss' },
  {
    name: 'Tasnim',
    url: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories'
  },
  { name: 'Khabaronline', url: 'https://www.khabaronline.ir/rss' }
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true
});

function getItems(data) {
  const channel = data?.rss?.channel;

  if (channel?.item) {
    return Array.isArray(channel.item)
      ? channel.item
      : [channel.item];
  }

  const entries = data?.feed?.entry;

  if (entries) {
    return Array.isArray(entries) ? entries : [entries];
  }

  return [];
}

for (const source of sources) {
  console.log('\n' + '='.repeat(65));
  console.log(`SOURCE: ${source.name}`);
  console.log('='.repeat(65));

  try {
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(20000)
    });

    const xml = await response.text();

    console.log('HTTP STATUS:', response.status);
    console.log('CONTENT TYPE:', response.headers.get('content-type'));

    if (!response.ok) {
      console.log('ERROR: HTTP request failed');
      continue;
    }

    const data = parser.parse(xml);
    const items = getItems(data);

    console.log('ITEM COUNT:', items.length);

    for (const [index, item] of items.slice(0, 5).entries()) {
      console.log(`\n--- ITEM ${index + 1} ---`);
      console.log('TITLE:', item.title ?? null);
      console.log('LINK:', item.link ?? null);
      console.log('CATEGORY TYPE:', typeof item.category);
      console.log(
        'RAW CATEGORY:',
        JSON.stringify(item.category ?? null, null, 2)
      );
    }
  } catch (error) {
    console.log('ERROR:', error.message);
  }
}
