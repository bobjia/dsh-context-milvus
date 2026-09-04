/**
 * dsh-context-milvus — 浏览器端配置组件
 *
 * 注册 settings.plugin.item 插槽，在 DSH Web GUI 设置 → 插件页面中渲染
 * dsh-context-milvus 插件的配置表单。
 *
 * 此文件通过 package.json 的 "dsh.client" 字段暴露给 DSH 客户端模块加载器。
 */
window.__ModuleLoader__.load({
  id: "dsh-context-milvus",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // --- 依赖 ---
    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");

    // --- 常量 ---
    var NS = "dsh-context-milvus";

    // --- 本地化字典 ---
    var zh = {
      title: "DSH Context Milvus",
      description: "语义代码搜索插件（Milvus 向量数据库）",
      milvusAddress: "Milvus 地址",
      milvusAddressHint: "Milvus 服务地址，例如 localhost:19530",
      milvusToken: "Milvus Token",
      milvusTokenHint: "Milvus 鉴权 Token（如不需要可留空）",
      milvusCollection: "集合名称",
      milvusCollectionHint: "Milvus 集合名称，用于存储代码向量",
      milvusDim: "向量维度",
      milvusDimHint: "Embedding 向量维度（需与模型匹配）",
      embeddingEndpoint: "Embedding API 地址",
      embeddingEndpointHint: "例如 Ollama: http://localhost:11434/api/embed",
      embeddingApiKey: "Embedding API 密钥",
      embeddingApiKeyHint: "Embedding API 密钥（如不需要可留空）",
      embeddingModel: "Embedding 模型",
      embeddingModelHint: "例如 Ollama: nomic-embed-text",
      indexRoot: "代码仓库路径",
      indexRootHint: "代码仓库根路径，用于索引时扫描文件",
      indexExtensions: "索引文件后缀",
      indexExtensionsHint: "逗号分隔，留空则索引所有支持的扩展名",
      hybridMode: "混合搜索",
      hybridModeHint: "启用 BM25 全文检索 + 向量语义搜索",
      indexIgnoreDirs: "忽略目录",
      indexIgnoreDirsHint: "逗号分隔，默认跳过 dist, build, target, __pycache__, vendor 等",
      ignorePatterns: "自定义忽略规则",
      ignorePatternsHint: "每行一个 gitignore 风格模式",
      merkleFilePath: "Merkle 状态文件路径",
      merkleFilePathHint: "增量索引哈希状态文件路径，留空使用默认位置",
      bm25RrfK: "BM25 RRF 参数 k",
      bm25RrfKHint: "RRF 融合算法参数，默认 60",
      adrEnabled: "ADR 决策记忆",
      adrEnabledHint: "启用后可使用 ADR 工具记录/查询架构决策",
      adrRoot: "ADR 目录",
      adrRootHint: "ADR 文件目录（相对 indexRoot），默认 docs/decisions",
      adrCollection: "ADR 集合名称",
      adrCollectionHint: "Milvus 中存储 ADR 向量的集合名称",
      adrConstraintReinjectEvery: "约束重注入步数",
      adrConstraintReinjectEveryHint: "每 N 步自动重注入约束（0=禁用）",
      adrSystemPrompt: "自定义 ADR 规则提示",
      adrSystemPromptHint: "系统提示词中 ADR 规则的定制内容（留空使用默认）",
      save: "保存",
      discard: "撤销",
      overridden: "已覆盖",
      reset: "重置",
      invalidNumber: "请输入有效数字",
    };

    var en = {
      title: "DSH Context Milvus",
      description: "Semantic code search plugin (Milvus vector DB)",
      milvusAddress: "Milvus Address",
      milvusAddressHint: "e.g. localhost:19530",
      milvusToken: "Milvus Token",
      milvusTokenHint: "Authentication token (leave blank if not needed)",
      milvusCollection: "Collection Name",
      milvusCollectionHint: "Milvus collection for code vectors",
      milvusDim: "Vector Dimension",
      milvusDimHint: "Must match the embedding model's dimension",
      embeddingEndpoint: "Embedding API Endpoint",
      embeddingEndpointHint: "e.g. http://localhost:11434/api/embed",
      embeddingApiKey: "Embedding API Key",
      embeddingApiKeyHint: "API key (leave blank if not needed)",
      embeddingModel: "Embedding Model",
      embeddingModelHint: "e.g. nomic-embed-text",
      indexRoot: "Code Repository Path",
      indexRootHint: "Root path for indexing",
      indexExtensions: "Index File Extensions",
      indexExtensionsHint: "Comma-separated, empty = all supported extensions",
      hybridMode: "Hybrid Search",
      hybridModeHint: "Enable BM25 full-text + vector semantic search",
      indexIgnoreDirs: "Ignore Directories",
      indexIgnoreDirsHint: "Comma-separated, defaults skip dist, build, target, etc.",
      ignorePatterns: "Custom Ignore Patterns",
      ignorePatternsHint: "One gitignore-style pattern per line",
      merkleFilePath: "Merkle State File Path",
      merkleFilePathHint: "Leave blank for default location",
      bm25RrfK: "BM25 RRF k",
      bm25RrfKHint: "RRF fusion parameter, default 60",
      adrEnabled: "ADR Decision Memory",
      adrEnabledHint: "Enable ADR tools for recording/querying architecture decisions",
      adrRoot: "ADR Directory",
      adrRootHint: "ADR file directory (relative to indexRoot), default docs/decisions",
      adrCollection: "ADR Collection Name",
      adrCollectionHint: "Milvus collection storing ADR embeddings",
      adrConstraintReinjectEvery: "Constraint Re-inject Steps",
      adrConstraintReinjectEveryHint: "Auto re-inject constraints every N steps (0=disabled)",
      adrSystemPrompt: "Custom ADR Rules Prompt",
      adrSystemPromptHint: "Custom section for ADR rules in system prompt (empty=default)",
      save: "Save",
      discard: "Discard",
      overridden: "Overridden",
      reset: "Reset",
      invalidNumber: "Enter a valid number",
    };

    // --- ValueField 组件 ---
    // 接收 CardForm 格式的字段状态: { text, overridden, invalid }
    function ValueField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var numeric = props.numeric;
      var secret = props.secret;
      var disabled = props.disabled;
      var text = props.text;
      var overridden = props.overridden;
      var invalid = props.invalid;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var invalidLabel = props.invalidLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var displayValue = text !== undefined && text !== null ? text : "";
      var isInvalid = invalid === true;

      return jsxRuntime.jsxs("div", {
        style: {
          marginBottom: "10px",
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "4px",
            },
            children: [
              jsxRuntime.jsx("label", {
                htmlFor: id,
                style: {
                  fontSize: "13px",
                  fontWeight: 500,
                  lineHeight: "1.5",
                  color: "var(--dsw-alias-label-primary, #333)",
                },
                children: label,
              }),
              overridden
                ? jsxRuntime.jsx("span", {
                    style: {
                      fontSize: "12px",
                      color: "var(--dsw-alias-label-secondary, #666)",
                    },
                    children: overriddenLabel,
                  })
                : null,
            ],
          }),
          jsxRuntime.jsx("div", {
            style: { position: "relative" },
            children: jsxRuntime.jsx("input", {
              id: id,
              type: secret ? "password" : "text",
              inputMode: numeric ? "numeric" : "text",
              value: displayValue,
              disabled: disabled,
              onChange: function (e) {
                onEdit(e.target.value);
              },
              style: {
                width: "100%",
                boxSizing: "border-box",
                font: "inherit",
                fontSize: "13px",
                lineHeight: "1.5",
                padding: "6px 10px",
                border: "1px solid " + (isInvalid
                  ? "var(--dsw-alias-state-danger, #ff4d4f)"
                  : "var(--dsw-alias-border-l2, #e5e5e5)"),
                borderRadius: "8px",
                background: disabled
                  ? "var(--dsw-alias-bg-layer-3, #fafafa)"
                  : "var(--dsw-alias-bg-layer-1, #fff)",
                color: "var(--dsw-alias-label-primary, #333)",
                outline: "none",
              },
            }),
          }),
          isInvalid
            ? jsxRuntime.jsx("p", {
                style: {
                  margin: "2px 0 0 0",
                  fontSize: "12px",
                  lineHeight: "1.5",
                  color: "var(--dsw-alias-state-danger, #ff4d4f)",
                },
                children: invalidLabel,
              })
            : null,
          hint
            ? jsxRuntime.jsx("p", {
                style: {
                  margin: "2px 0 0 0",
                  fontSize: "12px",
                  lineHeight: "1.5",
                  color: "var(--dsw-alias-label-tertiary, #999)",
                },
                children: hint,
              })
            : null,
          overridden
            ? jsxRuntime.jsx("button", {
                onClick: function (e) {
                  e.preventDefault();
                  onReset();
                },
                disabled: disabled,
                style: {
                  font: "inherit",
                  color: "var(--dsw-alias-label-secondary, #666)",
                  cursor: disabled ? "default" : "pointer",
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
                  textAlign: "left",
                },
                children: resetLabel || "Reset",
              })
            : null,
        ],
      });
    }

    // --- BooleanField 组件 ---
    function BooleanField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var disabled = props.disabled;
      var text = props.text;
      var overridden = props.overridden;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var checked = text === "true" || text === true;

      return jsxRuntime.jsxs("div", {
        style: {
          marginBottom: "10px",
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
        },
        children: [
          jsxRuntime.jsx("label", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: disabled ? "default" : "pointer",
              flexShrink: 0,
            },
            children: jsxRuntime.jsx("input", {
              id: id,
              type: "checkbox",
              checked: checked,
              disabled: disabled,
              onChange: function (e) {
                onEdit(e.target.checked ? "true" : "false");
              },
              style: {
                cursor: disabled ? "default" : "pointer",
              },
            }),
          }),
          jsxRuntime.jsxs("div", {
            style: { flex: "1", minWidth: 0 },
            children: [
              jsxRuntime.jsxs("div", {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                },
                children: [
                  jsxRuntime.jsx("label", {
                    htmlFor: id,
                    style: {
                      fontSize: "13px",
                      fontWeight: 500,
                      lineHeight: "1.5",
                      color: "var(--dsw-alias-label-primary, #333)",
                    },
                    children: label,
                  }),
                  overridden
                    ? jsxRuntime.jsx("span", {
                        style: {
                          fontSize: "12px",
                          color: "var(--dsw-alias-label-secondary, #666)",
                        },
                        children: overriddenLabel,
                      })
                    : null,
                ],
              }),
              hint
                ? jsxRuntime.jsx("p", {
                    style: {
                      margin: "2px 0 0 0",
                      fontSize: "12px",
                      lineHeight: "1.5",
                      color: "var(--dsw-alias-label-tertiary, #999)",
                    },
                    children: hint,
                  })
                : null,
              overridden
                ? jsxRuntime.jsx("button", {
                    onClick: function (e) {
                      e.preventDefault();
                      onReset();
                    },
                    disabled: disabled,
                    style: {
                      font: "inherit",
                      color: "var(--dsw-alias-label-secondary, #666)",
                      cursor: disabled ? "default" : "pointer",
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontSize: "12px",
                      lineHeight: "1.5",
                      textAlign: "left",
                    },
                    children: resetLabel || "Reset",
                  })
                : null,
            ],
          }),
        ],
      });
    }

    // --- TextareaField 组件 ---
    function TextareaField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var disabled = props.disabled;
      var text = props.text;
      var overridden = props.overridden;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var displayValue = text !== undefined && text !== null ? text : "";

      return jsxRuntime.jsxs("div", {
        style: {
          marginBottom: "10px",
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "4px",
            },
            children: [
              jsxRuntime.jsx("label", {
                htmlFor: id,
                style: {
                  fontSize: "13px",
                  fontWeight: 500,
                  lineHeight: "1.5",
                  color: "var(--dsw-alias-label-primary, #333)",
                },
                children: label,
              }),
              overridden
                ? jsxRuntime.jsx("span", {
                    style: {
                      fontSize: "12px",
                      color: "var(--dsw-alias-label-secondary, #666)",
                    },
                    children: overriddenLabel,
                  })
                : null,
            ],
          }),
          jsxRuntime.jsx("textarea", {
            id: id,
            value: displayValue,
            disabled: disabled,
            onChange: function (e) {
              onEdit(e.target.value);
            },
            rows: 3,
            style: {
              width: "100%",
              boxSizing: "border-box",
              font: "inherit",
              fontSize: "13px",
              lineHeight: "1.5",
              padding: "6px 10px",
              border: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
              borderRadius: "8px",
              background: disabled
                ? "var(--dsw-alias-bg-layer-3, #fafafa)"
                : "var(--dsw-alias-bg-layer-1, #fff)",
              color: "var(--dsw-alias-label-primary, #333)",
              outline: "none",
              resize: "vertical",
            },
          }),
          hint
            ? jsxRuntime.jsx("p", {
                style: {
                  margin: "2px 0 0 0",
                  fontSize: "12px",
                  lineHeight: "1.5",
                  color: "var(--dsw-alias-label-tertiary, #999)",
                },
                children: hint,
              })
            : null,
          overridden
            ? jsxRuntime.jsx("button", {
                onClick: function (e) {
                  e.preventDefault();
                  onReset();
                },
                disabled: disabled,
                style: {
                  font: "inherit",
                  color: "var(--dsw-alias-label-secondary, #666)",
                  cursor: disabled ? "default" : "pointer",
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
                  textAlign: "left",
                },
                children: resetLabel || "Reset",
              })
            : null,
        ],
      });
    }

    // --- 简单的 store 工厂 ---
    // 提供 { getSnapshot, subscribe, set }，满足 useSyncExternalStore 契约
    function createSimpleStore(init) {
      var state = init;
      var listeners = new Set();
      return {
        getSnapshot: function () { return state; },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        },
        set: function (next) {
          state = next;
          listeners.forEach(function (fn) { fn(); });
        },
      };
    }

    // --- 卡片组件 ---
    // 使用 CardForm 模式：renderSlot 自动将 hooks.milvusConfigCard 转为
    // useMilvusConfigCard hook，state 通过该 hook 获取
    function MilvusConfigCard(props) {
      var t = props.t;
      var state = props.useMilvusConfigCard(function (snapshot) { return snapshot; });
      var disabled = !state.writable || state.saving;
      var pending = !state.available;
      var expanded = react.useState(false);
      var isExpanded = expanded[0];
      var setExpanded = expanded[1];

      var fields = [
        { id: "milvusAddress", label: t("milvusAddress"), hint: t("milvusAddressHint"), numeric: false, secret: false },
        { id: "milvusToken", label: t("milvusToken"), hint: t("milvusTokenHint"), numeric: false, secret: true },
        { id: "milvusCollection", label: t("milvusCollection"), hint: t("milvusCollectionHint"), numeric: false, secret: false },
        { id: "milvusDim", label: t("milvusDim"), hint: t("milvusDimHint"), numeric: true, secret: false },
        { id: "embeddingEndpoint", label: t("embeddingEndpoint"), hint: t("embeddingEndpointHint"), numeric: false, secret: false },
        { id: "embeddingApiKey", label: t("embeddingApiKey"), hint: t("embeddingApiKeyHint"), numeric: false, secret: true },
        { id: "embeddingModel", label: t("embeddingModel"), hint: t("embeddingModelHint"), numeric: false, secret: false },
        { id: "indexRoot", label: t("indexRoot"), hint: t("indexRootHint"), numeric: false, secret: false },
        { id: "indexExtensions", label: t("indexExtensions"), hint: t("indexExtensionsHint"), numeric: false, secret: false },
        { id: "merkleFilePath", label: t("merkleFilePath"), hint: t("merkleFilePathHint"), numeric: false, secret: false },
        { id: "indexIgnoreDirs", label: t("indexIgnoreDirs"), hint: t("indexIgnoreDirsHint"), numeric: false, secret: false },
        { id: "bm25RrfK", label: t("bm25RrfK"), hint: t("bm25RrfKHint"), numeric: true, secret: false },
        { id: "adrEnabled", label: t("adrEnabled"), hint: t("adrEnabledHint"), numeric: false, secret: false, boolean: true },
        { id: "adrRoot", label: t("adrRoot"), hint: t("adrRootHint"), numeric: false, secret: false },
        { id: "adrCollection", label: t("adrCollection"), hint: t("adrCollectionHint"), numeric: false, secret: false },
        { id: "adrConstraintReinjectEvery", label: t("adrConstraintReinjectEvery"), hint: t("adrConstraintReinjectEveryHint"), numeric: true, secret: false },
        { id: "adrSystemPrompt", label: t("adrSystemPrompt"), hint: t("adrSystemPromptHint"), numeric: false, secret: false, textarea: true },
      ];

      return jsxRuntime.jsxs("div", {
        style: {
          border: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
          borderRadius: "12px",
          background: "var(--dsw-alias-bg-layer-2, #fff)",
          overflow: "hidden",
        },
        children: [
          // 头部（可点击展开/折叠）
          jsxRuntime.jsxs("div", {
            onClick: function () { setExpanded(!isExpanded); },
            onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!isExpanded); } },
            role: "button",
            tabIndex: 0,
            "aria-expanded": isExpanded,
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              cursor: "pointer",
              gap: "12px",
              userSelect: "none",
            },
            children: [
              jsxRuntime.jsxs("div", {
                style: { flex: "1", minWidth: 0 },
                children: [
                  jsxRuntime.jsx("h3", {
                    style: {
                      margin: 0,
                      fontSize: "15px",
                      fontWeight: 600,
                      lineHeight: "1.5",
                      color: "var(--dsw-alias-label-primary, #333)",
                    },
                    children: t("title"),
                  }),
                  jsxRuntime.jsx("p", {
                    style: {
                      margin: "2px 0 0 0",
                      fontSize: "13px",
                      lineHeight: "1.5",
                      color: "var(--dsw-alias-label-tertiary, #999)",
                    },
                    children: t("description"),
                  }),
                ],
              }),
              jsxRuntime.jsxs("div", {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  flexShrink: 0,
                },
                children: [
                  pending
                    ? jsxRuntime.jsx("span", {
                        style: {
                          color: "var(--dsw-alias-label-tertiary, #999)",
                          fontSize: "12px",
                        },
                        children: "加载中…",
                      })
                    : null,
                  jsxRuntime.jsx("span", {
                    style: {
                      color: "var(--dsw-alias-label-tertiary, #999)",
                      flex: "none",
                      transition: "transform 0.16s",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "14px",
                      height: "14px",
                      transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                    },
                    children: jsxRuntime.jsx("svg", {
                      width: "14",
                      height: "14",
                      viewBox: "0 0 14 14",
                      fill: "none",
                      children: jsxRuntime.jsx("path", {
                        d: "M4.375 5.25L7 7.875L9.625 5.25",
                        stroke: "currentColor",
                        strokeWidth: "1.5",
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      }),
                    }),
                  }),
                ],
              }),
            ],
          }),
          // 展开的内容
          isExpanded
            ? jsxRuntime.jsxs(react.Fragment, {
                children: [
                  // 表单体
                  jsxRuntime.jsx("div", {
                    style: {
                      padding: "0 20px 16px",
                    },
                    children: jsxRuntime.jsxs("div", {
                      children: fields.map(function (field) {
                        var fieldState = state[field.id] || {};
                        if (field.boolean) {
                          return jsxRuntime.jsx(BooleanField, {
                            id: "plugin-config-dsh-context-milvus-" + field.id,
                            label: field.label,
                            hint: field.hint,
                            disabled: disabled,
                            overriddenLabel: t("overridden"),
                            resetLabel: t("reset"),
                            text: fieldState.text,
                            overridden: fieldState.overridden,
                            onEdit: function (text) {
                              props.edit(field.id, text);
                            },
                            onReset: function () {
                              props.resetField(field.id);
                            },
                          }, field.id);
                        }
                        if (field.textarea) {
                          return jsxRuntime.jsx(TextareaField, {
                            id: "plugin-config-dsh-context-milvus-" + field.id,
                            label: field.label,
                            hint: field.hint,
                            disabled: disabled,
                            overriddenLabel: t("overridden"),
                            resetLabel: t("reset"),
                            text: fieldState.text,
                            overridden: fieldState.overridden,
                            onEdit: function (text) {
                              props.edit(field.id, text);
                            },
                            onReset: function () {
                              props.resetField(field.id);
                            },
                          }, field.id);
                        }
                        return jsxRuntime.jsx(ValueField, {
                          id: "plugin-config-dsh-context-milvus-" + field.id,
                          label: field.label,
                          hint: field.hint,
                          numeric: field.numeric,
                          secret: field.secret,
                          disabled: disabled,
                          overriddenLabel: t("overridden"),
                          resetLabel: t("reset"),
                          invalidLabel: t("invalidNumber"),
                          text: fieldState.text,
                          overridden: fieldState.overridden,
                          invalid: fieldState.invalid,
                          onEdit: function (text) {
                            props.edit(field.id, text);
                          },
                          onReset: function () {
                            props.resetField(field.id);
                          },
                        }, field.id);
                      }),
                    }),
                  }),
                  // 混合搜索字段
                  jsxRuntime.jsx("div", {
                    style: {
                      padding: "0 20px 16px",
                    },
                    children: jsxRuntime.jsx(BooleanField, {
                      id: "plugin-config-dsh-context-milvus-hybridMode",
                      label: t("hybridMode"),
                      hint: t("hybridModeHint"),
                      disabled: disabled,
                      overriddenLabel: t("overridden"),
                      resetLabel: t("reset"),
                      text: (state.hybridMode || {}).text,
                      overridden: (state.hybridMode || {}).overridden,
                      onEdit: function (text) {
                        props.edit("hybridMode", text);
                      },
                      onReset: function () {
                        props.resetField("hybridMode");
                      },
                    }),
                  }),
                  // 自定义忽略规则字段
                  jsxRuntime.jsx("div", {
                    style: {
                      padding: "0 20px 16px",
                    },
                    children: jsxRuntime.jsx(TextareaField, {
                      id: "plugin-config-dsh-context-milvus-ignorePatterns",
                      label: t("ignorePatterns"),
                      hint: t("ignorePatternsHint"),
                      disabled: disabled,
                      overriddenLabel: t("overridden"),
                      resetLabel: t("reset"),
                      text: (state.ignorePatterns || {}).text,
                      overridden: (state.ignorePatterns || {}).overridden,
                      onEdit: function (text) {
                        props.edit("ignorePatterns", text);
                      },
                      onReset: function () {
                        props.resetField("ignorePatterns");
                      },
                    }),
                  }),
                  // 底部操作栏
                  jsxRuntime.jsxs("div", {
                    style: {
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: "8px",
                      padding: "12px 20px",
                      borderTop: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
                    },
                    children: [
                      jsxRuntime.jsx("button", {
                        onClick: function (e) {
                          e.preventDefault();
                          props.discard();
                        },
                        disabled: disabled || !state.dirty,
                        style: {
                          font: "inherit",
                          color: "var(--dsw-alias-label-secondary, #666)",
                          cursor: (disabled || !state.dirty) ? "default" : "pointer",
                          background: "var(--dsw-alias-bg-layer-3, #fafafa)",
                          border: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
                          borderRadius: "8px",
                          padding: "6px 16px",
                          fontSize: "13px",
                          lineHeight: "1.5",
                        },
                        children: t("discard"),
                      }),
                      jsxRuntime.jsx("button", {
                        onClick: function (e) {
                          e.preventDefault();
                          props.save();
                        },
                        disabled: disabled,
                        style: {
                          font: "inherit",
                          color: disabled
                            ? "var(--dsw-alias-label-tertiary, #999)"
                            : "var(--dsw-alias-label-primary-inverse, #fff)",
                          cursor: disabled ? "default" : "pointer",
                          background: disabled
                            ? "var(--dsw-alias-bg-layer-3, #fafafa)"
                            : "var(--dsw-alias-brand-primary, #1677ff)",
                          border: "none",
                          borderRadius: "8px",
                          padding: "6px 16px",
                          fontSize: "13px",
                          lineHeight: "1.5",
                          fontWeight: 500,
                        },
                        children: state.saving ? "保存中…" : t("save"),
                      }),
                    ],
                  }),
                ],
              })
            : null,
        ],
      });
    }

    // --- 导出声明（cordis fiber inject）---
    var inject = ["slots", "locale", "settingsScope"];

    // --- 应用入口 ---
    function apply(ctx) {
      // 注册本地化字典
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); });

      // 绑定 settings namespace 作用域
      var scope = ctx.settingsScope.bind({ namespace: NS });

      // 表单状态管理
      var staged = {};        // 暂存编辑值: { field: text }
      var saving = false;
      var failed = false;

      // 字段类型映射，用于 save 时的类型转换
      var fieldTypes = {
        milvusAddress: "string",
        milvusToken: "string",
        milvusCollection: "string",
        milvusDim: "number",
        embeddingEndpoint: "string",
        embeddingApiKey: "string",
        embeddingModel: "string",
        indexRoot: "string",
        indexExtensions: "string",
        merkleFilePath: "string",
        indexIgnoreDirs: "string",
        ignorePatterns: "string",
        hybridMode: "boolean",
        bm25RrfK: "number",
        adrEnabled: "boolean",
        adrRoot: "string",
        adrCollection: "string",
        adrConstraintReinjectEvery: "number",
        adrSystemPrompt: "string",
      };

      function toTypedValue(field, text) {
        var type = fieldTypes[field] || "string";
        if (type === "number") {
          var n = Number(text);
          return isNaN(n) ? text : n;
        }
        if (type === "boolean") return text === "true" || text === true;
        return text;
      }

      // 构建完整表单状态
      function buildState() {
        var snapshot = scope.getSnapshot();
        var available = snapshot.status === "ready";
        var writable = snapshot.writable;
        var value = snapshot.value || {};
        var base = snapshot.base || {};

        // 字段列表
        var fieldIds = [
          "milvusAddress", "milvusToken", "milvusCollection", "milvusDim",
          "embeddingEndpoint", "embeddingApiKey", "embeddingModel",
          "indexRoot", "indexExtensions", "merkleFilePath",
          "indexIgnoreDirs", "ignorePatterns", "hybridMode", "bm25RrfK",
          "adrEnabled", "adrRoot", "adrCollection",
          "adrConstraintReinjectEvery", "adrSystemPrompt",
        ];

        var fields = {};
        fieldIds.forEach(function (field) {
          var stagedText = staged[field];
          var currentValue = value[field];
          var baseValue = base[field];
          var isOverridden = value[field] !== undefined && value[field] !== baseValue;

          if (stagedText !== undefined) {
            fields[field] = {
              text: stagedText,
              overridden: true,
              invalid: false,
            };
          } else if (currentValue !== undefined) {
            fields[field] = {
              text: String(currentValue),
              overridden: isOverridden,
              invalid: false,
            };
          } else {
            fields[field] = {
              text: "",
              overridden: false,
              invalid: false,
            };
          }
        });

        return {
          available: available,
          writable: writable,
          dirty: Object.keys(staged).length > 0,
          invalid: false,
          saving: saving,
          failed: failed,
          ...fields,
        };
      }

      // store 供 hooks 使用
      var store = createSimpleStore(buildState());

      // 订阅 scope 变更
      scope.subscribe(function () {
        if (!saving) store.set(buildState());
      });

      // 表单动作
      var actions = {
        edit: function (field, text) {
          staged[field] = text;
          failed = false;
          store.set(buildState());
        },
        resetField: function (field) {
          delete staged[field];
          store.set(buildState());
        },
        save: function () {
          var plan = Object.keys(staged);
          if (plan.length === 0 || saving) return;
          saving = true;
          store.set(buildState());
          var promises = plan.map(function (field) {
            var text = staged[field];
            if (text === "") {
              return scope.unset(field);
            } else {
              return scope.set(field, toTypedValue(field, text));
            }
          });
          Promise.all(promises).then(function () {
            staged = {};
            saving = false;
            failed = false;
            store.set(buildState());
          }).catch(function () {
            saving = false;
            failed = true;
            store.set(buildState());
          });
        },
        discard: function () {
          if (Object.keys(staged).length === 0 && !failed) return;
          staged = {};
          failed = false;
          store.set(buildState());
        },
      };

      // 注册 settings.plugin.item 插槽
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register(
          {
            name: "settings.plugin.item",
            key: NS,
            locale: NS,
            inject: function () {
              return {
                hooks: { milvusConfigCard: store },
                edit: actions.edit,
                resetField: actions.resetField,
                save: actions.save,
                discard: actions.discard,
              };
            },
          },
          MilvusConfigCard
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});