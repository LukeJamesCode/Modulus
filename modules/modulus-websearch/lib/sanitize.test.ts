import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeEntities, domainOf, htmlToText, isSafeUrl, truncate } from './sanitize.js';

test('isSafeUrl allows public http(s)', () => {
  assert.equal(isSafeUrl('https://example.com/page'), true);
  assert.equal(isSafeUrl('http://news.bbc.co.uk/a/b'), true);
});

test('isSafeUrl blocks non-web schemes and credentials', () => {
  assert.equal(isSafeUrl('file:///etc/passwd'), false);
  assert.equal(isSafeUrl('ftp://example.com'), false);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('http://user:pass@example.com'), false);
  assert.equal(isSafeUrl('not a url'), false);
});

test('isSafeUrl blocks loopback, private, link-local, and metadata addresses', () => {
  assert.equal(isSafeUrl('http://localhost/'), false);
  assert.equal(isSafeUrl('http://127.0.0.1/'), false);
  assert.equal(isSafeUrl('http://10.0.0.5/'), false);
  assert.equal(isSafeUrl('http://192.168.1.1/'), false);
  assert.equal(isSafeUrl('http://172.16.0.1/'), false);
  assert.equal(isSafeUrl('http://169.254.169.254/latest/meta-data/'), false); // cloud metadata
  assert.equal(isSafeUrl('http://[::1]/'), false);
  assert.equal(isSafeUrl('http://[fd00::1]/'), false);
  assert.equal(isSafeUrl('http://service.internal/'), false);
  assert.equal(isSafeUrl('http://box.local/'), false);
});

test('htmlToText strips markup and scripts, decodes entities', () => {
  const html = '<div>Hello <b>world</b><script>steal()</script> &amp; friends<br>line two</div>';
  const text = htmlToText(html);
  assert.ok(text.includes('Hello world'));
  assert.ok(text.includes('& friends'));
  assert.ok(!text.includes('steal'));
  assert.ok(text.includes('line two'));
});

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('a &amp; b &#39;c&#39; &lt;x&gt;'), "a & b 'c' <x>");
});

test('truncate cuts on a word boundary with an ellipsis', () => {
  assert.equal(truncate('one two three four', 9), 'one two…');
  assert.equal(truncate('short', 50), 'short');
});

test('domainOf strips www and tolerates junk', () => {
  assert.equal(domainOf('https://www.example.com/x'), 'example.com');
  assert.equal(domainOf('garbage'), '');
});
