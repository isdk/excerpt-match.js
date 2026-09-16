// cjk-number 是可选 peer 依赖，可能未安装 —— 补一个宽松声明，
// 这样 typecheck 在两种情况下都能过（运行时用动态 import 并 try/catch）。
declare module 'cjk-number' {
  export const number: {
    parse(input: string, options?: { strict?: boolean }): number | bigint;
  };
}
