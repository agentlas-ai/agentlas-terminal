#!/usr/bin/env node
'use strict';
/** Explicit Git-package exception to npm SRI: exact Git tree -> declared offline build -> package.files runtime manifest.
 * It never runs npm prepare/install, adopts a current package folder, or fetches a Git object. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),Module=require('node:module'),crypto=require('node:crypto');
const {snapshotSources,outputOutsideRepositories,assertExactCommit}=require('./build-core-snapshot.cjs'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=(p,j)=>fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
function run(command,args,cwd){const p=cp.spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024});if(p.status!==0)throw Object.assign(new Error('verified_git_package_build_failed'),{details:{command,args,stdout:p.stdout,stderr:p.stderr,status:p.status}});return p.stdout;}
function files(root){let all=[];function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true})){if(d.isSymbolicLink())throw Error('git_runtime_symlink');if(d.isDirectory())walk(path.join(dir,d.name));else if(d.isFile())all.push(path.join(dir,d.name));}}walk(root);return all.sort();}
function projectRuntimeMetadata(pkg) {
  const developmentScripts = new Set(['build', 'typecheck', 'prepare', 'measure:study', 'verify:source-plugin-pins']);
  const retained = {}, removedScriptNames = [];
  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) throw Error('git_package_scripts_review_required');
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'test' || name.startsWith('test:') || developmentScripts.has(name)) {
      removedScriptNames.push(name);
    } else if (name === 'build:archive' && command === 'node scripts/build-archive.cjs') {
      retained[name] = command;
    } else {
      throw Object.assign(new Error('git_package_script_classification_review_required'), {details: {name}});
    }
  }
  return {ruleVersion: 'agentlas.runtime-package-metadata.v1', packageJson: {...pkg, scripts: retained}, removedScriptNames: removedScriptNames.sort(), retainedScriptNames: Object.keys(retained).sort()};
}
function validateRuntimeMetadata(pkg, runtime) {
  const references = [];
  function check(target, basis) {
    if (typeof target !== 'string' || path.isAbsolute(target) || target.includes('\\') || target.includes('*') || target.split('/').includes('..')) throw Object.assign(new Error('git_package_metadata_reference_review_required'), {details: {basis}});
    const file = path.resolve(runtime, target);
    if (!file.startsWith(runtime + path.sep) || !fs.existsSync(file)) throw Object.assign(new Error('git_package_metadata_reference_missing'), {details: {basis, target}});
    references.push({basis, target});
  }
  for (const key of ['main', 'module', 'types', 'typings']) if (pkg[key] !== undefined) check(pkg[key], key);
  function entries(value, basis) {
    if (value === null || value === false) return;
    if (typeof value === 'string') {check(value, basis); return;}
    if (!value || typeof value !== 'object') throw Error('git_package_metadata_entries_review_required');
    for (const [key, item] of Object.entries(value)) entries(item, basis + '.' + key);
  }
  if (pkg.exports !== undefined) entries(pkg.exports, 'exports');
  if (pkg.bin !== undefined) entries(pkg.bin, 'bin');
  for (const target of pkg.files) check(target, 'files');
  if (pkg.scripts['build:archive'] !== undefined) check('scripts/build-archive.cjs', 'scripts.build:archive');
  return references;
}
async function build({repo,commit,toolRoot,output,expectedName,expectedVersion}){repo=fs.realpathSync(repo);toolRoot=fs.realpathSync(toolRoot);output=path.resolve(output);outputOutsideRepositories(output,[repo,toolRoot]);assertExactCommit(repo,commit);if(fs.existsSync(output)||output===repo||output.startsWith(repo+path.sep)||output.startsWith(toolRoot+path.sep))throw Error('new_external_git_build_output_required');fs.mkdirSync(output);const source=path.join(output,'source'),sourceReceipt=snapshotSources(repo,commit,source,['src','ui','service','vendor','scripts/build-intellect-ui.cjs','scripts/build-archive.cjs','scripts/build-science-jbrowse-runtime.cjs','scripts/build-science-math-runtime.cjs','package.json','tsconfig.json','README.md','PROVENANCE.md','HOST-REQUIREMENTS.md','science-renderer-packs/jbrowse-core/jbrowse-runtime.pinned.js']);const sourcePackageJsonBytes=fs.readFileSync(path.join(source,'package.json')),pkg=JSON.parse(sourcePackageJsonBytes);if(pkg.name!==expectedName||pkg.version!==expectedVersion)throw Error('git_package_identity_mismatch');if(pkg.scripts?.build!=='tsc -p tsconfig.json && node scripts/build-intellect-ui.cjs')throw Error('git_package_build_recipe_review_required');const req=Module.createRequire(path.join(toolRoot,'package.json')),ts=req('typescript'),semver=req('semver');if(!semver.satisfies(ts.version,pkg.devDependencies?.typescript||''))throw Error('git_package_compiler_range_mismatch');fs.symlinkSync(path.join(repo,'node_modules'),path.join(source,'node_modules'),'dir');const sourceRequire=Module.createRequire(path.join(source,'package.json'));if(sha(fs.readFileSync(sourceRequire.resolve('typescript')))!==sha(fs.readFileSync(req.resolve('typescript'))))throw Error('git_package_ui_compiler_differs');const compiler=req.resolve('typescript/bin/tsc');let stdout='';try{stdout+=run(process.execPath,[compiler,'-p','tsconfig.json','--noEmitOnError','--listFiles'],source);stdout+=run(process.execPath,['scripts/build-intellect-ui.cjs'],source);}catch(e){save(path.join(output,'failed.json'),{error:e.message,...e.details});throw e;}fs.writeFileSync(path.join(output,'build.stdout.log'),stdout);const runtime=path.join(output,'package');fs.mkdirSync(runtime);if(!Array.isArray(pkg.files)||pkg.files.some(x=>path.isAbsolute(x)||x.split('/').includes('..')))throw Error('git_package_runtime_allowlist_invalid');const allow=['package.json',...pkg.files];for(const rel of allow){const from=path.join(source,rel),to=path.join(runtime,rel);if(!fs.existsSync(from))throw Object.assign(new Error('git_package_runtime_allowlist_missing'),{details:{rel}});fs.cpSync(from,to,{recursive:true,dereference:false});}const projected=projectRuntimeMetadata(pkg),runtimePackageJsonBytes=Buffer.from(JSON.stringify(projected.packageJson,null,2)+'\n');fs.writeFileSync(path.join(runtime,'package.json'),runtimePackageJsonBytes);const metadataProjection={ruleVersion:projected.ruleVersion,sourcePackageJsonSha256:sha(sourcePackageJsonBytes),runtimePackageJsonSha256:sha(runtimePackageJsonBytes),removedScriptNames:projected.removedScriptNames,retainedScriptNames:projected.retainedScriptNames,references:validateRuntimeMetadata(projected.packageJson,runtime)};const runtimeFiles=files(runtime).map(file=>({file:path.relative(runtime,file).split(path.sep).join('/'),sha256:sha(fs.readFileSync(file))}));const tar=req('tar'),archive=path.join(output,'runtime-package.tgz');tar.c({file:archive,gzip:true,portable:true,noMtime:true,sync:true,cwd:runtime,prefix:'package'},runtimeFiles.map(x=>x.file));const dependencyInputs=stdout.split(/\r?\n/).filter(file=>path.isAbsolute(file)&&fs.existsSync(file)&&fs.statSync(file).isFile()).map(file=>({file,sha256:sha(fs.readFileSync(file))}));const receipt={builderSourceSha256:sha(fs.readFileSync(__filename)),dependencyInputs,schemaVersion:'agentlas.verified-git-runtime-package.v1',buildStatus:'passed',sourceCommit:commit,sourceTree:sourceReceipt.tree,sourceReceipt,packageName:pkg.name,packageVersion:pkg.version,declaredBuild:pkg.scripts.build,executedBuild:[process.execPath,compiler,'-p','tsconfig.json','--noEmitOnError','--listFiles','&&',process.execPath,'scripts/build-intellect-ui.cjs'],compiler:{version:ts.version,file:compiler,sha256:sha(fs.readFileSync(compiler))},runtimeAllowlist:allow,metadataProjection,runtimeFiles,archiveSha256:sha(fs.readFileSync(archive)),networkCalls:0,modelCalls:0,installedPackageSourceTrusted:false};const receiptPath=path.join(output,'verified-package-receipt.json');save(receiptPath,receipt);const contract={kind:'agentlas.verified-git-runtime-package.v1',sourceCommit:commit,packageName:pkg.name,packageVersion:pkg.version,archivePath:archive,archiveSha256:receipt.archiveSha256,receiptPath,receiptSha256:sha(fs.readFileSync(receiptPath))};save(path.join(output,'verified-package-contract.json'),contract);return contract;}
module.exports={build};if(require.main===module){const a=process.argv.slice(2),v=n=>a[a.indexOf('--'+n)+1];for(const key of ['repo','commit','tool-root','output','name','version'])if(!a.includes('--'+key))throw Error('missing_'+key);build({repo:v('repo'),commit:v('commit'),toolRoot:v('tool-root'),output:v('output'),expectedName:v('name'),expectedVersion:v('version')}).then(c=>console.log(JSON.stringify(c))).catch(e=>{console.error(JSON.stringify({error:e.message,details:e.details}));process.exitCode=1;});}
