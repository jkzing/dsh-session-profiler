declare module '*.css' {
  const text: string
  export default text
}

declare let module: { exports: Record<string, unknown> }
