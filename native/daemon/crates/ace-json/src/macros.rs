// SPDX-License-Identifier: Apache-2.0
//! `json!`: a value literal, as serde_json's macro writes one. Keys are string literals;
//! values are `null`, nested `[...]` / `{...}` literals or any expression with
//! `Into<Value>`. Object keys follow JavaScript's order, like every [`crate::Map`].

/// Build a [`crate::Value`] from a JSON-like literal.
#[macro_export]
macro_rules! json {
    (null) => { $crate::Value::Null };
    ([]) => { $crate::Value::Array($crate::Array::new()) };
    ([ $($tt:tt)+ ]) => {
        $crate::Value::Array($crate::Array::from($crate::json_internal!(@array [] $($tt)+)))
    };
    ({}) => { $crate::Value::Object($crate::Map::new()) };
    ({ $($tt:tt)+ }) => {{
        let mut map = $crate::Map::new();
        $crate::json_internal!(@object map $($tt)+);
        $crate::Value::Object(map)
    }};
    ($other:expr) => { $crate::Value::from($other) };
}

#[doc(hidden)]
#[macro_export]
macro_rules! json_internal {
    (@array [$($elems:expr,)*]) => { vec![$($elems,)*] };
    (@array [$($elems:expr,)*] null $(, $($rest:tt)*)?) => {
        $crate::json_internal!(@array [$($elems,)* $crate::Value::Null,] $($($rest)*)?)
    };
    (@array [$($elems:expr,)*] [$($a:tt)*] $(, $($rest:tt)*)?) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json!([$($a)*]),] $($($rest)*)?)
    };
    (@array [$($elems:expr,)*] {$($o:tt)*} $(, $($rest:tt)*)?) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json!({$($o)*}),] $($($rest)*)?)
    };
    (@array [$($elems:expr,)*] $next:expr, $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json!($next),] $($rest)*)
    };
    (@array [$($elems:expr,)*] $last:expr) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json!($last),])
    };
    (@object $map:ident) => {};
    (@object $map:ident $key:literal : null $(, $($rest:tt)*)?) => {
        $map.insert($key, $crate::Value::Null);
        $crate::json_internal!(@object $map $($($rest)*)?);
    };
    (@object $map:ident $key:literal : [$($a:tt)*] $(, $($rest:tt)*)?) => {
        $map.insert($key, $crate::json!([$($a)*]));
        $crate::json_internal!(@object $map $($($rest)*)?);
    };
    (@object $map:ident $key:literal : {$($o:tt)*} $(, $($rest:tt)*)?) => {
        $map.insert($key, $crate::json!({$($o)*}));
        $crate::json_internal!(@object $map $($($rest)*)?);
    };
    (@object $map:ident $key:literal : $value:expr, $($rest:tt)*) => {
        $map.insert($key, $crate::json!($value));
        $crate::json_internal!(@object $map $($rest)*);
    };
    (@object $map:ident $key:literal : $value:expr) => {
        $map.insert($key, $crate::json!($value));
    };
}
