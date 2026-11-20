/**
 * schema 工具层 —— 把 DSH 的**两套 schema 格式**各封一个构造函数。
 *
 * 这是本插件最容易翻车的地方，所以在这里一次性钉死：
 *
 * | 位置 | 格式 | 写法 |
 * |---|---|---|
 * | 内部参数描述 | DSH ParameterSchemaSpec 风格 | 每个参数上写 `required: true` |
 * | 注册时的 `parameters` | 标准 JSON Schema | 对象层写 `required: ['a','b']` 数组 |
 * | `output.schema` | **标准 JSON Schema** | 对象层写 `required: ['a','b']` 数组 |
 *
 * 写错的两种报错（都实际踩过）：
 * - 缺 `output.render` → `tool "x" must declare output { schema, render, presentationMeta? }`
 * - 在 output.schema 用内联 required → `unsupported JSON schema: ... required is not supported on type "number"`
 *
 * 用法：所有工具都必须经 `tool()` 包装，不得手写 `{ name, parameters, output }`。
 *
 * @module dsh-agent-ops/shared/schema
 */

/**
 * 参数构造器（插件内部格式：`required` 是属性上的布尔值）。
 */
export const p = {
  /**
   * @param {string} description - 模型可见说明
   * @param {boolean} [required=true] - 是否必填
   * @returns {object} ParameterSchemaSpec 片段
   */
  string (description, required = true) {
    return { type: 'string', required, description }
  },

  /** @param {string} description @param {boolean} [required=true] */
  number (description, required = true) {
    return { type: 'number', required, description }
  },

  /** @param {string} description @param {boolean} [required=true] */
  boolean (description, required = true) {
    return { type: 'boolean', required, description }
  },

  /**
   * @param {string[]} values - 允许值
   * @param {string} description
   * @param {boolean} [required=true]
   */
  enum (values, description, required = true) {
    return { type: 'string', required, description, enum: [...values] }
  },

  /**
   * @param {object} item - 元素 spec
   * @param {string} description
   * @param {boolean} [required=true]
   */
  array (item, description, required = true) {
    return { type: 'array', required, description, items: item }
  }
}

/**
 * 输出 schema 构造器（标准 JSON Schema：`required` 是对象层的字符串数组）。
 *
 * **默认不要求任何字段**：这些工具成功与失败返回的是不同的键集合
 * （成功没有 `code`/`reason`，失败没有业务字段），把全部字段标成必填会让
 * 每一次成功调用都被 registry 判成 invalid output。需要严格校验的读数类工具
 * 显式传 `required`。
 *
 * @param {Record<string, object>} properties - 属性表，**不要在属性上写 required**
 * @param {string[]} [required=[]] - 必填字段名
 * @returns {object} JSON Schema 对象
 */
export function out (properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties
  }
}

/** 输出属性：字符串。 */
export const s = description => ({ type: 'string', ...(description ? { description } : {}) })
/** 输出属性：数字。 */
export const n = description => ({ type: 'number', ...(description ? { description } : {}) })
/** 输出属性：布尔。 */
export const b = description => ({ type: 'boolean', ...(description ? { description } : {}) })
/** 输出属性：字符串数组。 */
export const sa = description => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) })
/** 输出属性：任意对象。 */
export function obj (properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties
  }
}

/**
 * 把工具结果渲染成模型可见文本。
 *
 * @param {unknown} _args
 * @param {unknown} value
 * @returns {{type:'text', text:string}[]}
 */
export const renderText = (_args, value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}]

/** 将内部参数描述转换成 registry 和模型接口使用的标准 JSON Schema。 */
export function compileParameters (parameters) {
  const required = []
  const valueSchema = spec => {
    const { required: _required, items, ...property } = spec
    return items === undefined ? property : { ...property, items: valueSchema(items) }
  }
  const properties = Object.fromEntries(Object.entries(parameters).map(([name, spec]) => {
    if (spec.required) required.push(name)
    return [name, valueSchema(spec)]
  }))
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * 工具定义的唯一入口。自动补 `output.render`，避免再忘。
 *
 * @param {object} def
 * @param {string} def.name
 * @param {string} def.description
 * @param {object} [def.parameters] - DSH 自定义格式
 * @param {object} def.schema - 标准 JSON Schema
 * @param {(args: object, exec: object) => Promise<object>|object} def.execute
 * @returns {object}
 */
export function tool (def) {
  const { name, description, parameters = {}, schema, execute } = def
  return {
    name,
    description,
    parameters: compileParameters(parameters),
    output: { schema, render: renderText },
    execute
  }
}
