// @flow

import {Readable} from 'stream';

import type {
  Asset as IAsset,
  AST,
  Blob,
  Config,
  Dependency as IDependency,
  DependencyOptions,
  Environment,
  File,
  FilePath,
  Meta,
  PackageJSON,
  Stats,
  TransformerResult
} from '@parcel/types';

import crypto from 'crypto';
import {md5FromString, md5FromFilePath} from '@parcel/utils/src/md5';
import {loadConfig} from '@parcel/utils/src/config';
import {
  readableFromStringOrBuffer,
  bufferStream
} from '@parcel/utils/src/stream';
import Cache from '@parcel/cache';
import Dependency from './Dependency';
import TapStream from '@parcel/utils/src/TapStream';

type AssetOptions = {|
  id?: string,
  hash?: ?string,
  filePath: FilePath,
  type: string,
  content?: Blob,
  contentKey?: ?string,
  ast?: ?AST,
  dependencies?: Iterable<[string, IDependency]>,
  connectedFiles?: Iterable<[FilePath, File]>,
  isIsolated?: boolean,
  outputHash?: string,
  env: Environment,
  meta?: Meta,
  stats: Stats
|};

type SerializedOptions = {|
  ...AssetOptions,
  ...{|
    connectedFiles: Array<[FilePath, File]>,
    dependencies: Array<[string, IDependency]>
  |}
|};

export default class Asset implements IAsset {
  id: string;
  hash: ?string;
  filePath: FilePath;
  type: string;
  ast: ?AST;
  dependencies: Map<string, IDependency>;
  connectedFiles: Map<FilePath, File>;
  isIsolated: boolean;
  outputHash: string;
  env: Environment;
  meta: Meta;
  stats: Stats;
  content: Blob;
  contentKey: ?string;

  constructor(options: AssetOptions) {
    this.id =
      options.id ||
      md5FromString(
        options.filePath + options.type + JSON.stringify(options.env)
      );
    this.hash = options.hash;
    this.filePath = options.filePath;
    this.isIsolated = options.isIsolated == null ? false : options.isIsolated;
    this.type = options.type;
    this.content = options.content || '';
    this.contentKey = options.contentKey;
    this.ast = options.ast || null;
    this.dependencies = options.dependencies
      ? new Map(options.dependencies)
      : new Map();
    this.connectedFiles = options.connectedFiles
      ? new Map(options.connectedFiles)
      : new Map();
    this.outputHash = options.outputHash || '';
    this.env = options.env;
    this.meta = options.meta || {};
    this.stats = options.stats;
  }

  serialize(): SerializedOptions {
    // Exclude `code` and `ast` from cache
    return {
      id: this.id,
      hash: this.hash,
      filePath: this.filePath,
      type: this.type,
      dependencies: Array.from(this.dependencies),
      connectedFiles: Array.from(this.connectedFiles),
      isIsolated: this.isIsolated,
      outputHash: this.outputHash,
      env: this.env,
      meta: this.meta,
      stats: this.stats,
      contentKey: this.contentKey
    };
  }

  /*
   * Prepares the asset for being serialized to the cache by commiting its
   * content and map of the asset to the cache.
   */
  async commit(): Promise<void> {
    this.ast = null;

    let contentStream = this.getStream();
    if (
      // $FlowFixMe
      typeof contentStream.bytesRead === 'number' &&
      contentStream.bytesRead > 0
    ) {
      throw new Error(
        'Stream has already been read. This may happen if a plugin reads from a stream and does not replace it.'
      );
    }

    let size = 0;
    let hash = crypto.createHash('md5');

    // Since we can only read from the stream once, compute the content length
    // and hash while it's being written to the cache.
    this.contentKey = await Cache.setStream(
      this.generateCacheKey('content'),
      contentStream.pipe(
        new TapStream(buf => {
          size += buf.length;
          hash.update(buf);
        })
      )
    );
    this.stats.size = size;
    this.outputHash = hash.digest('hex');
  }

  async getCode(): Promise<string> {
    this.readFromCacheIfKey();

    if (typeof this.content === 'string' || this.content instanceof Buffer) {
      return this.content.toString();
    }

    this.content = (await bufferStream(this.content)).toString();
    return this.content;
  }

  async getBuffer(): Promise<Buffer> {
    this.readFromCacheIfKey();

    if (typeof this.content === 'string' || this.content instanceof Buffer) {
      return Buffer.from(this.content);
    }

    this.content = await bufferStream(this.content);
    return this.content;
  }

  getStream(): Readable {
    this.readFromCacheIfKey();

    if (this.content instanceof Readable) {
      return this.content;
    }

    return readableFromStringOrBuffer(this.content);
  }

  setCode(code: string) {
    this.content = code;
  }

  setBuffer(buffer: Buffer) {
    this.content = buffer;
  }

  setStream(stream: Readable) {
    this.content = stream;
  }

  readFromCacheIfKey() {
    if (this.contentKey) {
      this.content = Cache.getStream(this.contentKey);
    }
  }

  generateCacheKey(key: string): string {
    return md5FromString(key + this.id + JSON.stringify(this.env));
  }

  addDependency(opts: DependencyOptions) {
    let {env, ...rest} = opts;
    let dep = new Dependency({
      ...rest,
      env: this.env.merge(env),
      sourcePath: this.filePath
    });

    this.dependencies.set(dep.id, dep);
    return dep.id;
  }

  async addConnectedFile(file: File) {
    if (!file.hash) {
      file.hash = await md5FromFilePath(file.filePath);
    }

    this.connectedFiles.set(file.filePath, file);
  }

  getConnectedFiles(): Array<File> {
    return Array.from(this.connectedFiles.values());
  }

  getDependencies(): Array<IDependency> {
    return Array.from(this.dependencies.values());
  }

  createChildAsset(result: TransformerResult): Asset {
    let content = result.content || result.code || '';

    let hash;
    let size;
    if (content === this.content) {
      hash = this.hash;
      size = this.stats.size;
    } else if (typeof content === 'string' || content instanceof Buffer) {
      hash = md5FromString(content);
      size = content.length;
    } else {
      hash = null;
      size = NaN;
    }

    let asset = new Asset({
      hash,
      filePath: this.filePath,
      type: result.type,
      content,
      ast: result.ast,
      isIsolated: result.isIsolated,
      env: this.env.merge(result.env),
      dependencies: this.dependencies,
      connectedFiles: this.connectedFiles,
      meta: {...this.meta, ...result.meta},
      stats: {
        time: 0,
        size
      }
    });

    let dependencies = result.dependencies;
    if (dependencies) {
      for (let dep of dependencies.values()) {
        asset.addDependency(dep);
      }
    }

    let connectedFiles = result.connectedFiles;
    if (connectedFiles) {
      for (let file of connectedFiles.values()) {
        asset.addConnectedFile(file);
      }
    }

    return asset;
  }

  async getConfig(
    filePaths: Array<FilePath>,
    options: ?{packageKey?: string, parse?: boolean}
  ): Promise<Config | null> {
    let packageKey = options && options.packageKey;
    let parse = options && options.parse;

    if (packageKey) {
      let pkg = await this.getPackage();
      if (pkg && pkg[packageKey]) {
        return pkg[packageKey];
      }
    }

    let conf = await loadConfig(
      this.filePath,
      filePaths,
      parse == null ? null : {parse}
    );
    if (!conf) {
      return null;
    }

    for (let file of conf.files) {
      this.addConnectedFile(file);
    }

    return conf.config;
  }

  async getPackage(): Promise<PackageJSON | null> {
    return this.getConfig(['package.json']);
  }
}
