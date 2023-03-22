/* eslint-disable @typescript-eslint/no-this-alias */
import * as t from '@babel/types';
import { OptimizedExpression, StateContext } from './types';
import getImportIdentifier from './get-import-identifier';
import { RUNTIME_CACHE } from './imports';

function mergeVariableDeclaration(statements: t.Statement[]) {
  let stack: t.VariableDeclarator[] = [];
  const newStatements: t.Statement[] = [];
  let value: t.Statement;
  for (let i = 0, len = statements.length; i < len; i++) {
    value = statements[i];
    if (t.isVariableDeclaration(value) && value.kind === 'let') {
      stack.push(...value.declarations);
    } else {
      if (stack.length) {
        newStatements.push(t.variableDeclaration('let', stack));
        stack = [];
      }
      newStatements.push(value);
    }
  }
  return newStatements;
}

export default class OptimizerScope {
  memo: t.Identifier | undefined;

  indeces = 0;

  ctx: StateContext;

  path: babel.NodePath;

  parent?: OptimizerScope;

  isInLoop?: boolean;

  statements: t.Statement[] = [];

  constructor(
    ctx: StateContext,
    path: babel.NodePath,
    parent?: OptimizerScope,
    isInLoop?: boolean,
  ) {
    this.ctx = ctx;
    this.path = path;
    this.parent = parent;
    this.isInLoop = isInLoop;
  }

  createHeader() {
    if (!this.memo) {
      this.memo = this.path.scope.generateUidIdentifier('c');
    }
    return this.memo;
  }

  createIndex() {
    const current = this.indeces;
    this.indeces += 1;
    return t.numericLiteral(current);
  }

  getMemoDeclaration() {
    if (!this.memo) {
      return undefined;
    }
    if (this.parent) {
      const header = this.parent.createHeader();
      const index = this.parent.createIndex();
      const pos = t.memberExpression(header, index, true);

      return t.variableDeclaration('let', [
        t.variableDeclarator(
          this.createHeader(),
          t.assignmentExpression(
            '||=',
            pos,
            t.newExpression(
              t.identifier('Array'),
              [t.numericLiteral(this.indeces)],
            ),
          ),
        ),
      ]);
    }
    return t.variableDeclaration('let', [
      t.variableDeclarator(
        this.memo,
        t.callExpression(
          getImportIdentifier(
            this.ctx,
            this.path,
            RUNTIME_CACHE,
          ),
          [
            getImportIdentifier(
              this.ctx,
              this.path,
              this.ctx.preset.memo,
            ),
            t.numericLiteral(this.indeces),
          ],
        ),
      ),
    ]);
  }

  loop: t.Identifier | undefined;

  loopIndex: t.Identifier | undefined;

  createLoopHeader() {
    if (!this.loop) {
      this.loop = this.path.scope.generateUidIdentifier('l');
    }
    return this.loop;
  }

  createLoopIndex() {
    if (!this.loopIndex) {
      this.loopIndex = this.path.scope.generateUidIdentifier('id');
    }
    return this.loopIndex;
  }

  getLoopMemoDeclaration() {
    if (!this.parent) {
      return undefined;
    }
    const header = this.parent.createHeader();
    const index = this.parent.createIndex();
    const id = this.createLoopIndex();
    const pos = t.memberExpression(header, index, true);

    return t.variableDeclaration('let', [
      t.variableDeclarator(
        this.createHeader(),
        t.assignmentExpression(
          '||=',
          pos,
          t.arrayExpression(),
        ),
      ),
      t.variableDeclarator(id, t.numericLiteral(0)),
    ]);
  }

  getLoopDeclaration() {
    const header = this.createHeader();
    const index = this.createLoopIndex();
    const localIndex = this.path.scope.generateUidIdentifier('lid');
    const pos = t.memberExpression(header, localIndex, true);
    return t.variableDeclaration('let', [
      t.variableDeclarator(localIndex, t.updateExpression('++', index)),
      t.variableDeclarator(
        this.createLoopHeader(),
        t.assignmentExpression(
          '||=',
          pos,
          t.newExpression(
            t.identifier('Array'),
            [t.numericLiteral(this.indeces)],
          ),
        ),
      ),
    ]);
  }

  getStatements() {
    const result = [...this.statements];
    const header = this.isInLoop
      ? this.getLoopDeclaration()
      : this.getMemoDeclaration();
    if (header) {
      return mergeVariableDeclaration([
        header,
        ...result,
      ]);
    }
    return mergeVariableDeclaration(result);
  }

  push(...statements: t.Statement[]) {
    this.statements = this.statements.concat(statements);
  }

  optimizedID = new WeakMap<t.Identifier, OptimizedExpression>();

  setOptimized(key: t.Identifier, value: OptimizedExpression) {
    this.optimizedID.set(key, value);
  }

  getOptimized(key: t.Identifier) {
    let current: OptimizerScope | undefined = this;
    while (current) {
      const result = current.optimizedID.get(key);
      if (result) {
        return result;
      }
      current = current.parent;
    }
    return undefined;
  }

  deleteOptimized(key: t.Identifier) {
    let current: OptimizerScope | undefined = this;
    while (current) {
      if (current.optimizedID.has(key)) {
        current.optimizedID.delete(key);
        return;
      }
      current = current.parent;
    }
  }

  constants = new WeakSet<t.Identifier>();

  addConstant(value: t.Identifier) {
    this.constants.add(value);
  }

  hasConstant(value: t.Identifier): boolean {
    let current: OptimizerScope | undefined = this;
    while (current) {
      const result = current.constants.has(value);
      if (result) {
        return result;
      }
      current = current.parent;
    }
    return false;
  }
}
