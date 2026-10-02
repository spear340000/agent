const ENTRYPOINT = [
  'import importlib.util, pathlib, sys',
  'script, log_path = sys.argv[1:3]',
  'spec = importlib.util.spec_from_file_location("workfolio_legal_rag", script)',
  'module = importlib.util.module_from_spec(spec)',
  'sys.modules[spec.name] = module',
  'spec.loader.exec_module(module)',
  'module.SERVER_LOG = pathlib.Path(log_path)',
  'module.serve()'
].join('; ');

export function buildLegalMcpLaunchArgs(scriptPath: string, logPath: string): string[] {
  return ['-c', ENTRYPOINT, scriptPath, logPath];
}
