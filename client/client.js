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
    var _slots = require("@deepseek-ai/dsh-client-ui-slots");

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
      save: "Save",
      discard: "Discard",
      overridden: "Overridden",
      reset: "Reset",
      invalidNumber: "Enter a valid number",
    };

    // --- 简单的 ValueField 组件 ---
    function ValueField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var numeric = props.numeric;
      var secret = props.secret;
      var disabled = props.disabled;
      var value = props.value;
      var draft = props.draft;
      var configured = props.configured;
      var overridden = props.overridden;
      var valid = props.valid;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var invalidLabel = props.invalidLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var displayValue = draft !== undefined && draft !== null ? draft : (value || "");
      var isInvalid = valid === false;

      return jsxRuntime.jsxs("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "12px 0",
          borderTop: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
            },
            children: [
              jsxRuntime.jsx("label", {
                htmlFor: id,
                style: {
                  flex: "1",
                  color: "var(--dsw-alias-label-primary, #333)",
                  fontSize: "13px",
                  fontWeight: 500,
                  lineHeight: "1.5",
                },
                children: label,
              }),
              overridden
                ? jsxRuntime.jsx("span", {
                    style: {
                      background: "var(--dsw-alias-bg-module-platform, #f0f0f0)",
                      color: "var(--dsw-alias-label-secondary, #666)",
                      borderRadius: "999px",
                      padding: "1px 8px",
                      fontSize: "11px",
                      fontWeight: 500,
                      lineHeight: "17px",
                    },
                    children: overriddenLabel || "Overridden",
                  })
                : null,
              configured
                ? jsxRuntime.jsx("span", {
                    style: {
                      color: "var(--dsw-alias-label-tertiary, #999)",
                      borderRadius: "999px",
                      padding: "1px 8px",
                      fontSize: "11px",
                      lineHeight: "17px",
                    },
                    children: "已配置",
                  })
                : null,
            ],
          }),
          jsxRuntime.jsx("input", {
            id: id,
            type: secret ? "password" : numeric ? "number" : "text",
            value: displayValue,
            disabled: disabled,
            onChange: function (e) {
              onEdit(e.target.value);
            },
            style: {
              border: "1px solid " + (isInvalid
                ? "var(--dsw-alias-label-error, #e53e3e)"
                : "var(--dsw-alias-border-l2, #e5e5e5)"),
              background: "var(--dsw-alias-bg-layer-3, #fafafa)",
              height: "34px",
              font: "inherit",
              color: "var(--dsw-alias-label-primary, #333)",
              borderRadius: "8px",
              padding: "0 12px",
              fontSize: "13px",
              lineHeight: "1.5",
              outline: "none",
            },
          }),
          isInvalid
            ? jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-label-error, #e53e3e)",
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
                },
                children: invalidLabel || "Invalid",
              })
            : null,
          hint
            ? jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-label-tertiary, #999)",
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
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

    // --- 布尔字段组件 ---
    function BooleanField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var disabled = props.disabled;
      var value = props.value;
      var draft = props.draft;
      var overridden = props.overridden;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var checked = draft !== undefined && draft !== null ? draft === "true" : (value === true);

      return jsxRuntime.jsxs("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "12px 0",
          borderTop: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
            },
            children: [
              jsxRuntime.jsx("label", {
                htmlFor: id,
                style: {
                  flex: "1",
                  color: "var(--dsw-alias-label-primary, #333)",
                  fontSize: "13px",
                  fontWeight: 500,
                  lineHeight: "1.5",
                },
                children: label,
              }),
              overridden
                ? jsxRuntime.jsx("span", {
                    style: {
                      background: "var(--dsw-alias-bg-module-platform, #f0f0f0)",
                      color: "var(--dsw-alias-label-secondary, #666)",
                      borderRadius: "999px",
                      padding: "1px 8px",
                      fontSize: "11px",
                      fontWeight: 500,
                      lineHeight: "17px",
                    },
                    children: overriddenLabel || "Overridden",
                  })
                : null,
            ],
          }),
          jsxRuntime.jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: "8px" },
            children: [
              jsxRuntime.jsx("input", {
                id: id,
                type: "checkbox",
                checked: checked,
                disabled: disabled,
                onChange: function (e) {
                  onEdit(e.target.checked ? "true" : "false");
                },
                style: { cursor: disabled ? "default" : "pointer" },
              }),
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
                    },
                    children: resetLabel || "Reset",
                  })
                : null,
            ],
          }),
          hint
            ? jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-label-tertiary, #999)",
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
                },
                children: hint,
              })
            : null,
        ],
      });
    }

    // --- 多行文本字段组件 ---
    function TextareaField(props) {
      var id = props.id;
      var label = props.label;
      var hint = props.hint;
      var disabled = props.disabled;
      var value = props.value;
      var draft = props.draft;
      var overridden = props.overridden;
      var overriddenLabel = props.overriddenLabel;
      var resetLabel = props.resetLabel;
      var onEdit = props.onEdit;
      var onReset = props.onReset;

      var displayValue = draft !== undefined && draft !== null ? draft : (value || "");

      return jsxRuntime.jsxs("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "12px 0",
          borderTop: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
            },
            children: [
              jsxRuntime.jsx("label", {
                htmlFor: id,
                style: {
                  flex: "1",
                  color: "var(--dsw-alias-label-primary, #333)",
                  fontSize: "13px",
                  fontWeight: 500,
                  lineHeight: "1.5",
                },
                children: label,
              }),
              overridden
                ? jsxRuntime.jsx("span", {
                    style: {
                      background: "var(--dsw-alias-bg-module-platform, #f0f0f0)",
                      color: "var(--dsw-alias-label-secondary, #666)",
                      borderRadius: "999px",
                      padding: "1px 8px",
                      fontSize: "11px",
                      fontWeight: 500,
                      lineHeight: "17px",
                    },
                    children: overriddenLabel || "Overridden",
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
              border: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
              background: "var(--dsw-alias-bg-layer-3, #fafafa)",
              font: "inherit",
              color: "var(--dsw-alias-label-primary, #333)",
              borderRadius: "8px",
              padding: "8px 12px",
              fontSize: "13px",
              lineHeight: "1.5",
              outline: "none",
              resize: "vertical",
              fontFamily: "monospace",
            },
          }),
          hint
            ? jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-label-tertiary, #999)",
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: "1.5",
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

    // --- 卡片组件 ---
    function MilvusConfigCard(props) {
      var t = props.t;
      var state = props.state;
      var disabled = state.saving;
      var pending = state.pending;

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
      ];

      return jsxRuntime.jsxs("div", {
        style: {
          border: "1px solid var(--dsw-alias-border-l2, #e5e5e5)",
          borderRadius: "12px",
          background: "var(--dsw-alias-bg-layer-2, #fff)",
          overflow: "hidden",
        },
        children: [
          // 头部
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              cursor: "pointer",
              gap: "12px",
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
              pending
                ? jsxRuntime.jsx("span", {
                    style: {
                      color: "var(--dsw-alias-label-tertiary, #999)",
                      fontSize: "12px",
                    },
                    children: "加载中…",
                  })
                : null,
            ],
          }),
          // 表单体
          jsxRuntime.jsx("div", {
            style: {
              padding: "0 20px 16px",
            },
            children: jsxRuntime.jsxs("div", {
              children: fields.map(function (field) {
                var fieldState = state[field.id] || {};
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
                  value: fieldState.value,
                  draft: fieldState.draft,
                  configured: fieldState.configured,
                  overridden: fieldState.overridden,
                  valid: fieldState.valid,
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
              value: (state.hybridMode || {}).value,
              draft: (state.hybridMode || {}).draft,
              configured: (state.hybridMode || {}).configured,
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
              value: (state.ignorePatterns || {}).value,
              draft: (state.ignorePatterns || {}).draft,
              configured: (state.ignorePatterns || {}).configured,
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
                disabled: disabled,
                style: {
                  font: "inherit",
                  color: "var(--dsw-alias-label-secondary, #666)",
                  cursor: disabled ? "default" : "pointer",
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
                children: t("save"),
              }),
            ],
          }),
        ],
      });
    }

    // --- 注册 settings.plugin.item 插槽 ---
    // ctx 由客户端加载器通过 apply(ctx) 参数注入，不能在 factory 顶层作用域直接引用。
    // inject 导出声明该 bundle 需要的客户端服务（cordis fiber inject），
    // 缺了它 ctx.slots / ctx.locale 会抛 "cannot get property ... without inject"。
    var inject = ["slots", "locale"];

    function apply(ctx) {
      // 注册本地化字典，供插槽渲染时 props.t() 解析文案
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));

      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register(
          {
            name: "settings.plugin.item",
            key: NS,
            locale: NS,
            inject: function () {
              return {};
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