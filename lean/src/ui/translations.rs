//! server/studioTranslations.js: the built-in Viewer's translations, one
//! language at a time. The page gets translations.js with English only and a
//! null for every other language; i18n.js fetches the one it shows
//! (/studio/i18n/<lang>.json) when it is first needed. The Studio file itself
//! is unchanged. Node imports it as a module; here a small reader of the
//! constant literals it is written in (objects, strings, numbers, spreads,
//! Object.freeze and names of earlier constants) evaluates it.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Mutex;

struct Loaded {
    stamp: String,
    etag: String,
    module: String,
    json: HashMap<String, String>,
}

pub struct Translations {
    file: PathBuf,
    cache: Mutex<Option<std::sync::Arc<Loaded>>>,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Num(f64),
    P(&'static str),
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let c: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() || ch == '\u{feff}' {
            i += 1;
        } else if ch == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < c.len() && !(c[i] == '*' && c[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if ch == '"' || ch == '\'' {
            let q = ch;
            i += 1;
            let mut s = String::new();
            loop {
                let Some(&x) = c.get(i) else { return Err("unterminated string".into()) };
                i += 1;
                if x == q {
                    break;
                }
                if x == '\n' {
                    return Err("newline in string".into());
                }
                if x != '\\' {
                    s.push(x);
                    continue;
                }
                let Some(&e) = c.get(i) else { return Err("bad escape".into()) };
                i += 1;
                match e {
                    'n' => s.push('\n'),
                    't' => s.push('\t'),
                    'r' => s.push('\r'),
                    'b' => s.push('\u{8}'),
                    'f' => s.push('\u{c}'),
                    'v' => s.push('\u{b}'),
                    '0' if !c.get(i).is_some_and(|d| d.is_ascii_digit()) => s.push('\0'),
                    '\n' => {}
                    '\r' => {
                        if c.get(i) == Some(&'\n') {
                            i += 1;
                        }
                    }
                    'x' => {
                        let h: String = c.get(i..i + 2).ok_or("bad \\x")?.iter().collect();
                        s.push(char::from_u32(u32::from_str_radix(&h, 16).map_err(|_| "bad \\x")?).ok_or("bad \\x")?);
                        i += 2;
                    }
                    'u' => {
                        let code = if c.get(i) == Some(&'{') {
                            let end = (i..c.len()).find(|&k| c[k] == '}').ok_or("bad \\u")?;
                            let h: String = c[i + 1..end].iter().collect();
                            i = end + 1;
                            u32::from_str_radix(&h, 16).map_err(|_| "bad \\u")?
                        } else {
                            let h: String = c.get(i..i + 4).ok_or("bad \\u")?.iter().collect();
                            i += 4;
                            u32::from_str_radix(&h, 16).map_err(|_| "bad \\u")?
                        };
                        // a surrogate pair written as two escapes
                        if (0xd800..0xdc00).contains(&code) && c.get(i) == Some(&'\\') && c.get(i + 1) == Some(&'u') {
                            let h: String = c.get(i + 2..i + 6).ok_or("bad \\u")?.iter().collect();
                            let lo = u32::from_str_radix(&h, 16).map_err(|_| "bad \\u")?;
                            if (0xdc00..0xe000).contains(&lo) {
                                i += 6;
                                s.push(char::from_u32(0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00)).ok_or("bad pair")?);
                                continue;
                            }
                        }
                        s.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    other => s.push(other),
                }
            }
            out.push(Tok::Str(s));
        } else if ch.is_ascii_digit() || (ch == '.' && c.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let s = i;
            while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '.' || c[i] == '_') {
                i += 1;
            }
            let t: String = c[s..i].iter().filter(|&&x| x != '_').collect();
            out.push(Tok::Num(crate::ui::js::string_number(&t)));
        } else if ch.is_alphabetic() || ch == '_' || ch == '$' {
            let s = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$') {
                i += 1;
            }
            out.push(Tok::Ident(c[s..i].iter().collect()));
        } else if ch == '.' && c.get(i + 1) == Some(&'.') && c.get(i + 2) == Some(&'.') {
            out.push(Tok::P("..."));
            i += 3;
        } else {
            let p = match ch {
                '{' => "{",
                '}' => "}",
                '[' => "[",
                ']' => "]",
                '(' => "(",
                ')' => ")",
                ',' => ",",
                ':' => ":",
                ';' => ";",
                '=' => "=",
                '.' => ".",
                '-' => "-",
                _ => return Err(format!("unexpected {ch:?}")),
            };
            out.push(Tok::P(p));
            i += 1;
        }
    }
    Ok(out)
}

struct Parser {
    t: Vec<Tok>,
    i: usize,
    consts: HashMap<String, Value>,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }
    fn next(&mut self) -> Option<Tok> {
        let t = self.t.get(self.i).cloned();
        self.i += 1;
        t
    }
    fn eat(&mut self, p: &str) -> bool {
        if self.peek() == Some(&Tok::P(match p {
            "{" => "{",
            "}" => "}",
            "]" => "]",
            ")" => ")",
            "," => ",",
            ":" => ":",
            ";" => ";",
            "=" => "=",
            "." => ".",
            "(" => "(",
            "..." => "...",
            _ => return false,
        })) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, p: &str) -> Result<(), String> {
        if self.eat(p) { Ok(()) } else { Err(format!("expected {p} at token {}", self.i)) }
    }

    fn program(&mut self) -> Result<(), String> {
        while self.peek().is_some() {
            if self.eat(";") {
                continue;
            }
            if self.peek() == Some(&Tok::Ident("export".into())) {
                self.i += 1;
            }
            match self.next() {
                Some(Tok::Ident(k)) if k == "const" || k == "let" || k == "var" => {}
                t => return Err(format!("unexpected {t:?}")),
            }
            let Some(Tok::Ident(name)) = self.next() else { return Err("expected a name".into()) };
            self.expect("=")?;
            let v = self.expr()?;
            self.consts.insert(name, v);
            self.eat(";");
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<Value, String> {
        match self.next() {
            Some(Tok::Str(s)) => Ok(Value::String(s)),
            Some(Tok::Num(n)) => Ok(crate::ui::js::num(n)),
            Some(Tok::P("-")) => match self.next() {
                Some(Tok::Num(n)) => Ok(crate::ui::js::num(-n)),
                t => Err(format!("unexpected {t:?}")),
            },
            Some(Tok::P("{")) => {
                let mut m = Map::new();
                loop {
                    if self.eat("}") {
                        break;
                    }
                    if self.eat("...") {
                        if let Value::Object(o) = self.expr()? {
                            for (k, v) in o {
                                m.insert(k, v);
                            }
                        }
                    } else {
                        let key = match self.next() {
                            Some(Tok::Ident(k)) | Some(Tok::Str(k)) => k,
                            Some(Tok::Num(n)) => crate::ui::js::number_string(n),
                            t => return Err(format!("bad key {t:?}")),
                        };
                        let v = if self.eat(":") {
                            self.expr()?
                        } else {
                            self.consts.get(&key).cloned().ok_or_else(|| format!("unknown {key}"))?
                        };
                        m.insert(key, v);
                    }
                    if !self.eat(",") {
                        self.expect("}")?;
                        break;
                    }
                }
                Ok(Value::Object(m))
            }
            Some(Tok::P("[")) => {
                let mut a = Vec::new();
                loop {
                    if self.eat("]") {
                        break;
                    }
                    a.push(self.expr()?);
                    if !self.eat(",") {
                        self.expect("]")?;
                        break;
                    }
                }
                Ok(Value::Array(a))
            }
            Some(Tok::Ident(id)) => match id.as_str() {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                "null" => Ok(Value::Null),
                "Object" => {
                    self.expect(".")?;
                    match self.next() {
                        Some(Tok::Ident(f)) if f == "freeze" => {}
                        t => return Err(format!("unexpected Object.{t:?}")),
                    }
                    self.expect("(")?;
                    let v = self.expr()?;
                    self.expect(")")?;
                    Ok(v)
                }
                _ => self.consts.get(&id).cloned().ok_or_else(|| format!("unknown {id}")),
            },
            t => Err(format!("unexpected {t:?}")),
        }
    }
}

/// The constants a file of literals defines (its `translations`, here).
pub fn eval_constants(src: &str) -> Result<HashMap<String, Value>, String> {
    let mut p = Parser { t: lex(src)?, i: 0, consts: HashMap::new() };
    p.program()?;
    Ok(p.consts)
}

impl Translations {
    pub fn new(file: PathBuf) -> Translations {
        Translations { file, cache: Mutex::new(None) }
    }

    fn load(&self) -> Result<std::sync::Arc<Loaded>, String> {
        let md = std::fs::metadata(&self.file).map_err(|e| e.to_string())?;
        let stamp = format!("{}-{}", md.size(), crate::sei::js_round(crate::scanner::ms_of(md.mtime(), md.mtime_nsec())));
        if let Some(c) = self.cache.lock().unwrap().as_ref().filter(|c| c.stamp == stamp) {
            return Ok(c.clone());
        }
        let src = std::fs::read_to_string(&self.file).map_err(|e| e.to_string())?;
        let consts = eval_constants(&src)?;
        let Some(Value::Object(tr)) = consts.get("translations") else { return Err("no translations".into()) };
        let tag: String = sha1_smol::Sha1::from(src.as_bytes()).digest().to_string().chars().take(16).collect();
        let mut m = Map::new();
        for (l, v) in tr {
            m.insert(l.clone(), if l == "en" { v.clone() } else { Value::Null });
        }
        let module = format!(
            "// English here; other languages: /studio/i18n/<lang>.json (server/studioTranslations.js)\nexport const translations = {};\n",
            Value::Object(m)
        );
        let loaded = std::sync::Arc::new(Loaded {
            stamp,
            etag: format!("W/\"tr-{tag}\""),
            module,
            json: tr.iter().map(|(l, v)| (l.clone(), v.to_string())).collect(),
        });
        *self.cache.lock().unwrap() = Some(loaded.clone());
        Ok(loaded)
    }

    /// The module the page imports: English, and a null for every other language.
    pub fn module(&self) -> Result<(String, String), String> {
        let c = self.load()?;
        Ok((c.module.clone(), c.etag.clone()))
    }

    /// One language, as JSON, or None if there is no such language.
    pub fn language(&self, lang: &str) -> Result<Option<(String, String)>, String> {
        let c = self.load()?;
        Ok(c.json.get(lang).map(|b| (b.clone(), format!("{}-{lang}\"", &c.etag[..c.etag.len() - 1]))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // test/studioTranslations.test.js
    #[test]
    fn english_in_the_module_others_on_their_own() {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/renderer/scripts/data/translations.js");
        let t = Translations::new(file.clone());
        let (body, etag) = t.module().unwrap();
        let full = eval_constants(&std::fs::read_to_string(&file).unwrap()).unwrap()["translations"].clone();
        let json_part = body.split_once("export const translations = ").unwrap().1.trim_end().trim_end_matches(';');
        let module: Value = serde_json::from_str(json_part).unwrap();
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&module), keys(&full), "every language is listed");
        assert_eq!(module["en"], full["en"]);
        for l in keys(&full).into_iter().filter(|l| l != "en") {
            assert!(module[&l].is_null(), "{l}");
        }
        assert!(full["en"]["ui"]["converter"]["navClips"] == "Clips", "spread of a frozen constant");
        assert!((body.len() as f64) < 0.2 * std::fs::metadata(&file).unwrap().len() as f64);
        let (es, es_tag) = t.language("es").unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&es).unwrap(), full["es"]);
        assert_ne!(es_tag, etag);
        assert!(t.language("xx").unwrap().is_none());
    }
}
