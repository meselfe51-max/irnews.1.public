import { XMLParser } from 'fast-xml-parser';
import { getRssCategory, getPageCategory, findJsonLdCategory } from '../src/source-category.mjs';
const parser = new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:true});
const articleUrl = 'https://example.com/news/123';
const tests = [
 ['RSS string',()=>getRssCategory({category:'سیاست'}),'سیاست'],
 ['RSS #text',()=>getRssCategory({category:{'#text':'اقتصاد'}}),'اقتصاد'],
 ['RSS term',()=>getRssCategory({category:{'@_term':'ورزش'}}),'ورزش'],
 ['RSS label',()=>getRssCategory({category:{'@_label':'فرهنگ'}}),'فرهنگ'],
 ['RSS multiple/deduplicate',()=>getRssCategory({category:['سیاست','اقتصاد','سیاست']}),'سیاست | اقتصاد'],
 ['RSS entity decode',()=>getRssCategory({category:'جهان &gt; اروپا'}),'جهان > اروپا'],
 ['RSS missing',()=>getRssCategory({}),null],
 ['RSS length limit',()=>getRssCategory({category:'الف'.repeat(251)}),null],
 ['Meta article section',()=>getPageCategory('<meta property="article:section" content="جامعه">',articleUrl),'جامعه'],
 ['Meta fallback',()=>getPageCategory('<meta name="section" content="اقتصاد">',articleUrl),'اقتصاد'],
 ['JSON-LD articleSection',()=>getPageCategory('<script type="application/ld+json">{"@type":"NewsArticle","articleSection":"فناوری"}</script>',articleUrl),'فناوری'],
 ['Breadcrumb article URL parent',()=>findJsonLdCategory({'@type':'BreadcrumbList',itemListElement:[
  {name:'خانه',item:'https://example.com/'},{name:'جهان',item:'https://example.com/world'},
  {name:'اروپا',item:'https://example.com/world/europe'},{name:'خبر',item:articleUrl}
 ]},articleUrl),'اروپا'],
 ['Breadcrumb penultimate fallback',()=>findJsonLdCategory({'@type':'BreadcrumbList',itemListElement:[{name:'خانه'},{name:'اقتصاد'},{name:'خبر'}]},articleUrl),'اقتصاد'],
 ['Breadcrumb article first',()=>findJsonLdCategory({'@type':'BreadcrumbList',itemListElement:[{name:'خبر',item:articleUrl}]},articleUrl),null],
 ['Nested JSON-LD breadcrumb',()=>findJsonLdCategory({'@type':'NewsArticle',mainEntityOfPage:{breadcrumb:{'@type':'BreadcrumbList',itemListElement:[{name:'خانه'},{name:'بین‌الملل'},{name:'خبر'}]}}},articleUrl),'بین‌الملل'],
 ['No category',()=>getPageCategory('<html><body>بدون دسته</body></html>',articleUrl),null],
];
let failures=0;
console.log('========== SHARED PRODUCTION PARSER TESTS ==========');
for (const [name,fn,expected] of tests) {
 let actual;
 try { actual=fn(); } catch(e) { actual='THREW: '+e.message; }
 const pass=actual===expected;
 console.log((pass?'PASS':'FAIL')+' | '+name+' | expected='+JSON.stringify(expected)+' | actual='+JSON.stringify(actual));
 if(!pass) failures++;
}
const fixtures=[
 ['<rss><channel><item><category>سیاست</category></item></channel></rss>','سیاست'],
 ['<rss><channel><item><category term="اقتصاد"/></item></channel></rss>','اقتصاد'],
];
for(const [xml,expected] of fixtures) {
 const item=parser.parse(xml)?.rss?.channel?.item;
 const actual=getRssCategory(item||{});
 const pass=actual===expected;
 console.log((pass?'PASS':'FAIL')+' | XML parser fixture | expected='+expected+' | actual='+actual);
 if(!pass) failures++;
}
console.log('LOCAL TEST FAILURES: '+failures);
console.log('DATABASE ACCESS: DISABLED');
console.log('DATABASE WRITES: NONE');
if(failures) process.exitCode=1;
