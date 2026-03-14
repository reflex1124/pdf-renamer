use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::types::{AnalysisResult, DEFAULT_TEMPLATE};

const ALPHA_CURRENCY_MARKERS: &[(&str, &str)] = &[
    ("USD", "USD"),
    ("US$", "USD"),
    ("AUD", "AUD"),
    ("CAD", "CAD"),
    ("SGD", "SGD"),
    ("HKD", "HKD"),
    ("JPY", "JPY"),
    ("EUR", "EUR"),
    ("GBP", "GBP"),
    ("CNY", "CNY"),
    ("RMB", "CNY"),
    ("CHF", "CHF"),
    ("KRW", "KRW"),
    ("INR", "INR"),
    ("THB", "THB"),
    ("TWD", "TWD"),
    ("NT$", "TWD"),
];

const SYMBOL_CURRENCY_MARKERS: &[(&str, &str)] = &[
    ("¥", "JPY"),
    ("円", "JPY"),
    ("€", "EUR"),
    ("£", "GBP"),
    ("₩", "KRW"),
    ("₹", "INR"),
    ("฿", "THB"),
    ("$", "USD"),
];

pub fn normalize_date(value: Option<&str>) -> String {
    let value = match value {
        Some(v) if !v.trim().is_empty() => v,
        _ => return "unknown-date".to_string(),
    };

    let normalized: String = value.nfkc().collect();
    let normalized = normalized.trim();

    let re_split = Regex::new(r"[^\d]+").unwrap();
    let parts: Vec<&str> = re_split
        .split(normalized)
        .filter(|s| !s.is_empty())
        .collect();

    if parts.len() >= 3 {
        let (first, second, third) = (parts[0], parts[1], parts[2]);
        if first.len() == 4 {
            return format!(
                "{}-{:0>2}-{:0>2}",
                first,
                second,
                third
            );
        }
        if third.len() == 4 {
            let year = third;
            let (month, day) = if first.parse::<u32>().unwrap_or(0) > 12 {
                (second, first)
            } else {
                (first, second)
            };
            return format!("{}-{:0>2}-{:0>2}", year, month, day);
        }
    }

    if parts.len() == 2 {
        let (first, second) = (parts[0], parts[1]);
        if first.len() == 4 {
            return format!("{}-{:0>2}-01", first, second);
        }
        if second.len() == 4 {
            return format!("{}-{:0>2}-01", second, first);
        }
    }

    let re_non_digit = Regex::new(r"[^\d]").unwrap();
    let digits = re_non_digit.replace_all(normalized, "-");
    let re_multi_dash = Regex::new(r"-{2,}").unwrap();
    let digits = re_multi_dash.replace_all(&digits, "-");
    let digits = digits.trim_matches('-');
    if digits.is_empty() {
        "unknown-date".to_string()
    } else {
        digits.to_string()
    }
}

pub fn sanitize_filename_component(value: Option<&str>, fallback: &str) -> String {
    let text = value.unwrap_or("").trim();
    let text = if text.is_empty() { fallback } else { text };

    let normalized: String = text.nfkc().collect();
    let re_invalid = Regex::new(r#"[\\/:*?"<>|\r\n\t]+"#).unwrap();
    let cleaned = re_invalid.replace_all(&normalized, "_");
    let re_multispace = Regex::new(r"\s+").unwrap();
    let cleaned = re_multispace.replace_all(&cleaned, " ");
    let cleaned = cleaned.trim_matches(|c| c == ' ' || c == '.' || c == '_');

    if cleaned.is_empty() {
        return fallback.to_string();
    }

    let result: String = cleaned.chars().take(60).collect();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

pub fn detect_currency(value: &str) -> String {
    let normalized: String = value.nfkc().collect();
    let upper = normalized.to_uppercase();

    for &(marker, code) in ALPHA_CURRENCY_MARKERS {
        if upper.contains(marker) {
            return code.to_string();
        }
    }

    for &(marker, code) in SYMBOL_CURRENCY_MARKERS {
        if normalized.contains(marker) {
            return code.to_string();
        }
    }

    String::new()
}

pub fn format_amount(value: Option<&str>) -> String {
    let value = match value {
        Some(v) if !v.trim().is_empty() => v,
        _ => return "unknown-amount".to_string(),
    };

    let normalized: String = value.nfkc().collect();
    let normalized = normalized.replace(',', "");
    let normalized = normalized.trim();

    let currency = detect_currency(normalized);
    let re_number = Regex::new(r"\d+(?:\.\d+)?").unwrap();
    match re_number.find(normalized) {
        Some(m) => {
            if currency.is_empty() {
                sanitize_filename_component(Some(m.as_str()), "unknown-amount")
            } else {
                format!("{}{}", currency, m.as_str())
            }
        }
        None => sanitize_filename_component(Some(normalized), "unknown-amount"),
    }
}

pub fn analysis_tokens(analysis: &AnalysisResult) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    map.insert(
        "date".to_string(),
        normalize_date(analysis.date.as_deref()),
    );
    map.insert(
        "issuer_name".to_string(),
        sanitize_filename_component(analysis.issuer_name.as_deref(), "unknown-issuer"),
    );
    map.insert(
        "document_type".to_string(),
        sanitize_filename_component(Some(&analysis.document_type), "other"),
    );
    map.insert(
        "amount".to_string(),
        format_amount(analysis.amount.as_deref()),
    );
    map.insert(
        "title".to_string(),
        sanitize_filename_component(analysis.title.as_deref(), "untitled"),
    );
    map.insert(
        "description".to_string(),
        sanitize_filename_component(analysis.description.as_deref(), "no-description"),
    );
    map
}

pub fn normalize_template(template: &str) -> String {
    let normalized: String = template.nfkc().collect();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        DEFAULT_TEMPLATE.to_string()
    } else {
        normalized.to_string()
    }
}

pub fn validate_template(template: &str) -> Result<(), String> {
    let normalized = normalize_template(template);
    let token_re = Regex::new(r"\{([a-z_]+)\}").unwrap();
    let available = &["date", "issuer_name", "document_type", "amount", "title", "description"];

    let tokens: Vec<String> = token_re
        .captures_iter(&normalized)
        .map(|c| c[1].to_string())
        .collect();

    if tokens.is_empty() {
        return Err(
            "トークンを1つ以上含めてください。例: {date}_{issuer_name}_{document_type}_{amount}"
                .to_string(),
        );
    }

    let invalid: Vec<String> = tokens
        .iter()
        .filter(|t| !available.contains(&t.as_str()))
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    if !invalid.is_empty() {
        let mut sorted = invalid;
        sorted.sort();
        return Err(format!("未対応トークンがあります: {}", sorted.join(", ")));
    }

    Ok(())
}

pub fn build_proposed_filename(analysis: &AnalysisResult, template: &str) -> String {
    let normalized_template = normalize_template(template);
    let token_map = analysis_tokens(analysis);

    let token_re = Regex::new(r"\{([a-z_]+)\}").unwrap();
    let rendered = token_re.replace_all(&normalized_template, |caps: &regex::Captures| {
        token_map
            .get(&caps[1])
            .cloned()
            .unwrap_or_else(|| "unknown".to_string())
    });

    let parts: Vec<String> = rendered
        .split('_')
        .map(|part| sanitize_filename_component(Some(part), ""))
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        let date = token_map.get("date").cloned().unwrap_or_default();
        let issuer = token_map.get("issuer_name").cloned().unwrap_or_default();
        let doc_type = token_map.get("document_type").cloned().unwrap_or_default();
        format!("{}_{}_{}", date, issuer, doc_type)
    } else {
        parts.join("_")
    }
}

pub fn ensure_extension(name: &str, extension: &str) -> String {
    let normalized_ext = if extension.starts_with('.') {
        extension.to_string()
    } else {
        format!(".{}", extension)
    };

    let stripped = name.trim();
    if stripped.to_lowercase().ends_with(&normalized_ext.to_lowercase()) {
        return stripped.to_string();
    }

    // Remove existing extension
    let re_ext = Regex::new(r"\.[^.]+$").unwrap();
    let without_ext = if let Some(m) = re_ext.find(stripped) {
        &stripped[..m.start()]
    } else {
        stripped
    };

    format!("{}{}", without_ext, normalized_ext)
}
