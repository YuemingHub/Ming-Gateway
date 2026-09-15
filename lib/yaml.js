'use strict';

/**
 * 极简 YAML 解析器（零依赖）
 *
 * 只实现网关配置需要的语法子集：
 *   - 嵌套映射（缩进）
 *   - 块序列（- item）
 *   - 内联数组 [a, b] 与内联对象 {k: v}
 *   - 单引号 / 双引号字符串
 *   - 数字 / 布尔 / null
 *   - # 注释（引号内不算）
 *   - | 与 > 块标量
 *
 * 不追求 YAML 1.2 全兼容，只保证网关配置文件可读。
 */

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/** 按逗号切分内联结构，跳过引号与嵌套括号内的逗号 */
function splitInline(s) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        out.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim() !== '') out.push(buf.trim());
  return out;
}

function unescape(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseScalar(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE' || s === 'no' || s === 'off') return false;

  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unescape(s.slice(1, -1));
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");

  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : splitInline(inner).map(parseScalar);
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const part of splitInline(inner)) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      obj[String(part.slice(0, i).trim())] = parseScalar(part.slice(i + 1));
    }
    return obj;
  }

  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(s)) return parseFloat(s);
  return s;
}

/**
 * @param {string} text
 * @returns {object}
 */
function parse(text) {
  if (typeof text !== 'string') throw new TypeError('yaml.parse 需要字符串输入');

  const raw = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const noComment = stripComment(raw[i]);
    if (noComment.trim() === '') continue;
    // 记录缩进（把 tab 当成 2 空格，避免混用导致层级错乱）
    const expanded = noComment.replace(/\t/g, '  ');
    const indent = expanded.length - expanded.replace(/^\s+/, '').length;
    lines.push({ n: i + 1, indent, text: expanded.trim(), raw: noComment });
  }

  let pos = 0;
  const peek = () => (pos < lines.length ? lines[pos] : null);

  function parseNode(indent) {
    const line = peek();
    if (!line) return null;

    if (line.indent < indent) return null;

    // 块序列
    if (line.text === '-' || line.text.startsWith('- ')) {
      return parseSequence(line.indent);
    }
    return parseMapping(indent);
  }

  function parseSequence(indent) {
    const arr = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML 第 ${line.n} 行缩进异常：${line.raw}`);
      if (!(line.text === '-' || line.text.startsWith('- '))) break;

      let content = line.text === '-' ? '' : line.text.slice(2).trim();
      pos++;

      if (content === '') {
        // 值是后续的子块
        const child = parseNode(indent + 1);
        arr.push(child === undefined ? null : child);
        continue;
      }

      const colon = findColon(content);
      if (colon > 0) {
        // "- key: value" 形式的映射项
        const key = content.slice(0, colon).trim();
        const rest = content.slice(colon + 1).trim();
        const map = {};
        if (rest === '') {
          // "- key:" 后面没有值。此时「什么算 key 的值」由缩进决定：
          // 序列项的键位于 indent + 2 这一列（"- " 之后），
          // 所以只有比这一列更深的行才是 key 的嵌套值；
          // 恰好落在 indent + 2 的行是【同级兄弟键】，必须留给下面的续行循环处理。
          // 反例（曾经的 bug）：key 的值被误当成后续整段兄弟映射，
          // 于是 {key: null, name: x} 被解析成 {key: {name: x}}，
          // 令牌空值检查因「key 是个对象」而漏检，客户端令牌会变成字符串 "[object Object]"。
          const keyCol = indent + 2;
          const next = peek();
          if (next && next.indent > keyCol) {
            map[stripQuotes(key)] = parseNode(next.indent);
          } else {
            map[stripQuotes(key)] = null;
          }
        } else {
          map[stripQuotes(key)] = parseScalar(rest);
        }
        // 后续缩进更深的 "key: value" 行属于同一个映射项
        // （YAML 中 "- id: x" 的子字段缩进为 "- " 之后的位置，即 indent + 2）
        let childIndent = null;
        while (pos < lines.length) {
          const l2 = lines[pos];
          if (l2.indent <= indent) break;
          if (childIndent === null) {
            // 第一个续行：可以是更深缩进的普通 key，也可以是嵌套序列
            if (l2.text === '-' || l2.text.startsWith('- ')) {
              // "- - a" 这种非常规写法不处理，交给外层
              break;
            }
            childIndent = l2.indent;
          }
          if (l2.indent !== childIndent) break;
          if (l2.text === '-' || l2.text.startsWith('- ')) break;
          const c2 = findColon(l2.text);
          if (c2 <= 0) break;

          const k2 = stripQuotes(l2.text.slice(0, c2).trim());
          const v2 = l2.text.slice(c2 + 1).trim();
          pos++;
          if (v2 === '') {
            const nxt = peek();
            map[k2] = nxt && nxt.indent > childIndent ? parseNode(nxt.indent) : null;
          } else if (v2 === '|' || v2 === '|-' || v2 === '>' || v2 === '>-') {
            const fold = v2[0] === '>';
            const keepTrailing = !v2.endsWith('-');
            const buf = [];
            while (pos < lines.length && lines[pos].indent > childIndent) {
              buf.push(lines[pos].raw.replace(/^\s*/, ''));
              pos++;
            }
            map[k2] = fold ? buf.join(' ').trim() : buf.join('\n').replace(/\n+$/, keepTrailing ? '\n' : '');
          } else {
            map[k2] = parseScalar(v2);
          }
        }
        arr.push(map);
        continue;
      }

      arr.push(parseScalar(content));
    }
    return arr;
  }

  function parseMapping(indent) {
    const obj = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML 第 ${line.n} 行缩进异常：${line.raw}`);
      if (line.text === '-' || line.text.startsWith('- ')) break;

      const colon = findColon(line.text);
      if (colon <= 0) throw new Error(`YAML 第 ${line.n} 行不是 key: value 结构：${line.raw}`);

      const key = stripQuotes(line.text.slice(0, colon).trim());
      let value = line.text.slice(colon + 1).trim();
      pos++;

      // 块标量 | 与 >
      if (value === '|' || value === '|-' || value === '>' || value === '>-') {
        const fold = value[0] === '>';
        const keepTrailing = !value.endsWith('-');
        const buf = [];
        while (pos < lines.length && lines[pos].indent > indent) {
          buf.push(lines[pos].raw.replace(/^\s*/, ''));
          pos++;
        }
        obj[key] = fold ? buf.join(' ').trim() : buf.join('\n').replace(/\n+$/, keepTrailing ? '\n' : '');
        continue;
      }

      if (value === '') {
        const next = peek();
        // 子块：映射或序列
        if (next && (next.indent > indent || (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))))) {
          obj[key] = parseNode(next.indent > indent ? next.indent : indent);
        } else {
          obj[key] = null;
        }
        continue;
      }

      obj[key] = parseScalar(value);
    }
    return obj;
  }

  const result = parseNode(0) || {};
  return result;
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 找到分隔 key 与 value 的冒号（跳过引号内的） */
function findColon(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      if (i === text.length - 1 || /\s/.test(text[i + 1])) return i;
    }
  }
  return -1;
}

module.exports = { parse };
