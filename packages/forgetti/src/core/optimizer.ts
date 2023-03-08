import * as babel from '@babel/core';
import * as t from '@babel/types';
import { forEach } from './arrays';
import { isNestedExpression, isPathValid } from './checks';
import getForeignBindings from './get-foreign-bindings';
import isGuaranteedLiteral from './is-guaranteed-literal';
import OptimizerScope from './optimizer-scope';
import { ComponentNode, OptimizedExpression, StateContext } from './types';
import unwrapNode from './unwrap-node';

function optimizedExpr(
  expr: t.Expression,
  deps?: t.Expression | t.Expression[],
  constant?: boolean,
): OptimizedExpression {
  return { expr, deps, constant };
}

function createDependencies(
  dependencies?: t.Expression | t.Expression[],
): t.Expression[] {
  if (dependencies) {
    if (Array.isArray(dependencies)) {
      return dependencies;
    }
    return [dependencies];
  }
  return [];
}

function mergeDependencies(
  target: t.Expression[],
  dependencies?: t.Expression | t.Expression[],
) {
  if (dependencies) {
    if (Array.isArray(dependencies)) {
      return target.push(...dependencies);
    }
    return target.push(dependencies);
  }
  return target;
}

export default class Optimizer {
  ctx: StateContext;

  path: babel.NodePath<ComponentNode>;

  scope: OptimizerScope;

  constructor(ctx: StateContext, path: babel.NodePath<ComponentNode>) {
    this.ctx = ctx;
    this.path = path;
    this.scope = new OptimizerScope(ctx, path);
  }

  createMemo(
    current: t.Expression,
    dependencies?: t.Expression | t.Expression[] | boolean,
  ): OptimizedExpression {
    if (t.isIdentifier(current)) {
      const optimized = this.scope.getOptimized(current);
      if (optimized) {
        return optimized;
      }
    }
    const header = (
      this.scope.isInLoop
        ? this.scope.createLoopHeader()
        : this.scope.createHeader()
    );
    const index = this.scope.createIndex();
    const pos = t.memberExpression(header, index, true);
    const vid = this.path.scope.generateUidIdentifier('v');

    let condition: t.Expression | undefined;

    if (Array.isArray(dependencies)) {
      const newSet = new Set<t.Identifier>();
      forEach(dependencies, (dependency) => {
        if (condition && dependency) {
          if (t.isIdentifier(dependency)) {
            if (!newSet.has(dependency)) {
              condition = t.logicalExpression('&&', condition, dependency);
              newSet.add(dependency);
            }
          } else {
            condition = t.logicalExpression('&&', condition, dependency);
          }
        } else if (dependency) {
          condition = dependency;
          if (t.isIdentifier(dependency)) {
            newSet.add(dependency);
          }
        }
      });
    } else if (dependencies === true) {
      // Do nothing
    } else if (dependencies) {
      condition = dependencies;
    } else {
      condition = t.callExpression(
        t.memberExpression(t.identifier('Object'), t.identifier('is')),
        [pos, current],
      );
    }

    let eqid: t.Expression;

    if (condition == null) {
      eqid = pos;
    } else if (t.isIdentifier(condition)) {
      eqid = condition;
    } else {
      eqid = this.path.scope.generateUidIdentifier('eq');
    }

    const declaration: t.VariableDeclarator[] = [];

    if (condition && !t.isIdentifier(condition)) {
      declaration.push(t.variableDeclarator(eqid, condition));
    }

    const optimized = optimizedExpr(vid, condition ? eqid : undefined);

    if (condition == null) {
      this.scope.addConstant(vid);
    }

    if (t.isIdentifier(current)) {
      this.scope.setOptimized(current, optimized);
      this.scope.setOptimized(vid, optimized);
    }

    const init = (
      condition
        ? t.conditionalExpression(
          eqid,
          pos,
          t.assignmentExpression('=', pos, current),
        )
        : t.assignmentExpression('||=', pos, current)
    );

    declaration.push(t.variableDeclarator(vid, init));

    this.scope.push(t.variableDeclaration('let', declaration));

    return optimized;
  }

  dependency = new WeakMap<t.Expression, OptimizedExpression>();

  createDependency<T extends t.Expression>(path: babel.NodePath<T>) {
    const optimized = this.optimizeExpression(path);
    if (optimized.constant) {
      return undefined;
    }
    if (t.isIdentifier(optimized.expr) && this.scope.hasConstant(optimized.expr)) {
      return optimized;
    }
    const result = this.dependency.get(path.node);
    if (result) {
      return result;
    }
    const record = this.createMemo(optimized.expr, false);
    this.dependency.set(path.node, record);
    return record;
  }

  memoizeIdentifier(
    path: babel.NodePath,
    id: t.Identifier,
  ) {
    if (path.scope.hasBinding(id.name, true)) {
      const binding = path.scope.getBindingIdentifier(id.name);
      if (binding) {
        return this.createMemo(binding, false);
      }
    }
    return optimizedExpr(id, undefined, true);
  }

  optimizeIdentifier(
    path: babel.NodePath<t.Identifier>,
  ) {
    return this.memoizeIdentifier(path, path.node);
  }

  memoizeMemberExpression(
    path: babel.NodePath<t.MemberExpression>,
  ) {
    const condition = createDependencies();
    const source = this.createDependency(path.get('object'));
    if (source) {
      path.node.object = source.expr;
      mergeDependencies(condition, source.deps);
    }
    if (path.node.computed) {
      const propertyPath = path.get('property');
      if (isPathValid(propertyPath, t.isExpression)) {
        const property = this.createDependency(propertyPath);
        if (property) {
          path.node.property = property.expr;
          mergeDependencies(condition, property.deps);
        }
      }
    }

    return {
      expr: path.node,
      deps: condition,
    };
  }

  optimizeMemberExpression(
    path: babel.NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  ) {
    const result = this.memoizeMemberExpression(path as babel.NodePath<t.MemberExpression>);
    return this.createMemo(result.expr, result.deps);
  }

  optimizeConditionalExpression(
    path: babel.NodePath<t.ConditionalExpression>,
  ) {
    const id = path.scope.generateUidIdentifier('v');
    const parent = this.scope;
    const optimizedTest = this.optimizeExpression(path.get('test'));
    const consequentPath = path.get('consequent');
    const consequent = new OptimizerScope(this.ctx, consequentPath, parent);
    this.scope = consequent;
    const optimizedConsequent = this.optimizeExpression(consequentPath);
    this.scope = parent;
    const alternatePath = path.get('alternate');
    const alternate = new OptimizerScope(this.ctx, alternatePath, parent);
    this.scope = alternate;
    const optimizedAlternate = this.optimizeExpression(alternatePath);
    this.scope = parent;

    consequent.push(
      t.expressionStatement(
        t.assignmentExpression('=', id, optimizedConsequent.expr),
      ),
    );
    alternate.push(
      t.expressionStatement(
        t.assignmentExpression('=', id, optimizedAlternate.expr),
      ),
    );
    this.scope.push(
      t.variableDeclaration(
        'let',
        [t.variableDeclarator(id)],
      ),
      t.ifStatement(
        optimizedTest.expr,
        t.blockStatement(consequent.getStatements()),
        t.blockStatement(alternate.getStatements()),
      ),
    );

    return optimizedExpr(id);
  }

  optimizeBinaryExpression(
    path: babel.NodePath<t.BinaryExpression>,
  ) {
    if (path.node.operator === '|>') {
      return optimizedExpr(path.node, undefined, true);
    }
    const leftPath = path.get('left');

    const dependencies = createDependencies();

    if (isPathValid(leftPath, t.isExpression)) {
      const left = this.createDependency(leftPath);
      if (left) {
        path.node.left = left.expr;
        mergeDependencies(dependencies, left.deps);
      }
    }
    const right = this.createDependency(path.get('right'));
    if (right) {
      path.node.right = right.expr;
      mergeDependencies(dependencies, right.deps);
    }

    return optimizedExpr(path.node, dependencies);
  }

  optimizeLogicalExpression(
    path: babel.NodePath<t.LogicalExpression>,
  ) {
    const id = path.scope.generateUidIdentifier('v');
    const parent = this.scope;
    const optimizedTest = this.optimizeExpression(path.get('left'));
    const alternate = new OptimizerScope(this.ctx, path, parent);
    this.scope = alternate;
    const optimizedAlternate = this.optimizeExpression(path.get('right'));
    this.scope = parent;
    alternate.push(
      t.expressionStatement(
        t.assignmentExpression('=', id, optimizedAlternate.expr),
      ),
    );
    const condition = path.node.operator === '??'
      ? t.binaryExpression('==', optimizedTest.expr, t.nullLiteral())
      : optimizedTest.expr;
    const first = t.blockStatement(alternate.getStatements());
    const last = t.expressionStatement(
      t.assignmentExpression('=', id, optimizedTest.expr),
    );
    const consequentExpr = path.node.operator === '||'
      ? last
      : first;
    const alternateExpr = path.node.operator === '||'
      ? first
      : last;
    this.scope.push(
      t.variableDeclaration(
        'let',
        [t.variableDeclarator(id)],
      ),
      t.ifStatement(
        condition,
        consequentExpr,
        alternateExpr,
      ),
    );
    return optimizedExpr(id);
  }

  optimizeUnaryExpression(
    path: babel.NodePath<t.UnaryExpression>,
  ) {
    const optimized = this.createDependency(path.get('argument'));
    if (optimized) {
      path.node.argument = optimized.expr;
      return optimizedExpr(path.node, optimized.deps);
    }
    return optimizedExpr(path.node);
  }

  optimizeEffect(
    path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
  ) {
    const [, dependencies] = path.get('arguments');
    if (dependencies && isPathValid(dependencies, t.isExpression)) {
      const optimizedArray = this.optimizeExpression(dependencies);
      path.node.arguments[1] = t.arrayExpression([optimizedArray.expr]);
      return optimizedExpr(path.node, optimizedArray.deps);
    }
    return optimizedExpr(path.node);
  }

  optimizeCallback(
    path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
  ) {
    const [callback, dependencies] = path.get('arguments');
    if (isPathValid(callback, t.isExpression)) {
      if (isPathValid(dependencies, t.isExpression)) {
        const dependency = this.createDependency(dependencies);
        if (dependency) {
          return this.createMemo(
            callback.node,
            dependency.deps,
          );
        }
        return this.createMemo(callback.node, true);
      }
    }
    return optimizedExpr(path.node);
  }

  optimizeMemo(
    path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
  ) {
    const [callback, dependencies] = path.get('arguments');
    if (isPathValid(callback, t.isExpression)) {
      if (isPathValid(dependencies, t.isExpression)) {
        const dependency = this.createDependency(dependencies);
        if (dependency) {
          return this.createMemo(
            t.callExpression(callback.node, []),
            dependency.deps,
          );
        }
        return this.createMemo(t.callExpression(callback.node, []), true);
      }
    }
    return optimizedExpr(path.node);
  }

  optimizeRef(
    path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
  ) {
    const arg = path.node.arguments[0];
    let init: t.Expression | undefined;
    if (arg) {
      if (t.isExpression(arg)) {
        init = arg;
      } else if (t.isSpreadElement(arg)) {
        init = t.memberExpression(arg.argument, t.numericLiteral(0), true);
      }
    }
    const expr = t.objectExpression([
      t.objectProperty(
        t.identifier('current'),
        init || t.identifier('undefined'),
      ),
    ]);
    return this.createMemo(expr, true);
  }

  optimizeCallExpression(
    path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
  ) {
    const calleePath = path.get('callee');
    if (isPathValid(calleePath, t.isExpression)) {
      let isHook = false;
      const trueID = unwrapNode(calleePath.node, t.isIdentifier);
      if (trueID) {
        const binding = path.scope.getBindingIdentifier(trueID.name);
        if (binding) {
          const registration = this.ctx.registrations.hooks.get(binding);
          if (registration) {
            switch (registration.type) {
              case 'callback':
                return this.optimizeCallback(path);
              case 'effect':
                return this.optimizeEffect(path);
              case 'memo':
                return this.optimizeMemo(path);
              case 'ref':
                return this.optimizeRef(path);
              default:
                isHook = true;
            }
          }
        }
        if (this.ctx.filters.hook?.test(trueID.name)) {
          isHook = true;
        }
      // Check if callee is potentially a namespace import
      }
      const trueMember = unwrapNode(calleePath.node, t.isMemberExpression);
      if (
        trueMember
        && !trueMember.computed
        && t.isIdentifier(trueMember.property)
      ) {
        const obj = unwrapNode(trueMember.object, t.isIdentifier);
        if (obj) {
          const binding = path.scope.getBindingIdentifier(obj.name);
          if (binding) {
            const registrations = this.ctx.registrations.hooksNamespaces.get(binding);
            if (registrations) {
              for (let i = 0, len = registrations.length; i < len; i += 1) {
                const registration = registrations[i];
                if (registration.name === trueMember.property.name) {
                  switch (registration.type) {
                    case 'callback':
                      return this.optimizeCallback(path);
                    case 'effect':
                      return this.optimizeEffect(path);
                    case 'memo':
                      return this.optimizeMemo(path);
                    case 'ref':
                      return this.optimizeRef(path);
                    default:
                      break;
                  }
                }
              }
            }
          }
        }
        if (this.ctx.filters.hook?.test(trueMember.property.name)) {
          isHook = true;
        }
      }

      if (isHook) {
        const argumentsPath = path.get('arguments');
        const dependencies = createDependencies();
        forEach(argumentsPath, (argument, i) => {
          if (isPathValid(argument, t.isExpression)) {
            const optimized = this.createDependency(argument);
            if (optimized) {
              mergeDependencies(dependencies, optimized.deps);
              path.node.arguments[i] = optimized.expr;
            }
          } else if (isPathValid(argument, t.isSpreadElement)) {
            const optimized = this.createDependency(argument.get('argument'));
            if (optimized) {
              mergeDependencies(dependencies, optimized.deps);
              argument.node.argument = optimized.expr;
            }
          }
        });
        return optimizedExpr(path.node);
      }
      // Build dependencies
      const condition = createDependencies();
      const callee = (
        (isPathValid(calleePath, t.isMemberExpression)
          || isPathValid(calleePath, t.isOptionalMemberExpression))
          ? this.memoizeMemberExpression(calleePath as babel.NodePath<t.MemberExpression>)
          : this.createDependency(calleePath)
      );
      if (callee) {
        path.node.callee = callee.expr;
        mergeDependencies(condition, callee.deps);
      }
      const argumentsPath = path.get('arguments');
      forEach(argumentsPath, (argument, i) => {
        if (isPathValid(argument, t.isExpression)) {
          const optimized = this.createDependency(argument);
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            path.node.arguments[i] = optimized.expr;
          }
        } else if (isPathValid(argument, t.isSpreadElement)) {
          const optimized = this.createDependency(argument.get('argument'));
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            argument.node.argument = optimized.expr;
          }
        }
      });
      return this.createMemo(path.node, condition);
    }
    return optimizedExpr(path.node);
  }

  optimizeAwaitYieldExpression(
    path: babel.NodePath<t.AwaitExpression | t.YieldExpression>,
  ) {
    if (path.node.argument) {
      const optimized = this.createDependency(path.get('argument') as babel.NodePath<t.Expression>);
      if (optimized) {
        path.node.argument = optimized.expr;
        return optimizedExpr(path.node, optimized.deps);
      }
    }
    return optimizedExpr(path.node);
  }

  optimizeFunctionExpression(
    path: babel.NodePath<t.ArrowFunctionExpression | t.FunctionExpression>,
  ) {
    const bindings = getForeignBindings(path);
    const dependencies = createDependencies();
    forEach(bindings, (binding) => {
      const optimized = this.memoizeIdentifier(path, binding);
      mergeDependencies(dependencies, optimized.deps);
    });
    return this.createMemo(path.node, dependencies);
  }

  optimizeLVal(
    path: babel.NodePath<t.LVal>,
    dirty = false,
  ): { expr: t.LVal, deps?: t.Expression | t.Expression[] } {
    if (isPathValid(path, t.isIdentifier)) {
      if (dirty) {
        const binding = path.scope.getBindingIdentifier(path.node.name);
        if (binding) {
          // Variable has been modified, marked as dirty
          this.scope.deleteOptimized(binding);
        }
      }
    }
    if (isPathValid(path, t.isMemberExpression)) {
      return this.memoizeMemberExpression(path);
    }
    // TODO Destructuring
    return {
      expr: path.node,
      deps: [],
    };
  }

  optimizeAssignmentExpression(
    path: babel.NodePath<t.AssignmentExpression>,
  ) {
    // TODO Work on left node
    const dependencies = createDependencies();
    const left = this.optimizeLVal(path.get('left'), true);
    path.node.left = left.expr;
    mergeDependencies(dependencies, left.deps);
    const right = this.createDependency(path.get('right'));
    if (right) {
      path.node.right = right.expr;
      mergeDependencies(dependencies, right.deps);
    }

    const variable = path.scope.generateUidIdentifier('v');
    this.scope.push(
      t.variableDeclaration('let', [t.variableDeclarator(variable, path.node)]),
    );

    return optimizedExpr(variable, dependencies);
  }

  optimizeArrayExpression(
    path: babel.NodePath<t.ArrayExpression | t.TupleExpression>,
  ) {
    const condition = createDependencies();
    const elementsPath = path.get('elements');
    forEach(elementsPath, (element, i) => {
      if (isPathValid(element, t.isExpression)) {
        const optimized = this.createDependency(element);
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          path.node.elements[i] = optimized.expr;
        }
      } else if (isPathValid(element, t.isSpreadElement)) {
        const optimized = this.createDependency(element.get('argument'));
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          element.node.argument = optimized.expr;
        }
      }
    });

    return this.createMemo(path.node, condition);
  }

  optimizeObjectExpression(
    path: babel.NodePath<t.ObjectExpression | t.RecordExpression>,
  ) {
    const condition = createDependencies();
    const elementsPath = path.get('properties');
    forEach(elementsPath, (element) => {
      if (isPathValid(element, t.isObjectProperty)) {
        const valuePath = element.get('value');

        if (isPathValid(valuePath, t.isExpression)) {
          const optimized = this.optimizeExpression(valuePath);
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            element.node.value = optimized.expr;
          }
        }

        if (element.node.computed) {
          const keyPath = element.get('key');
          if (isPathValid(keyPath, t.isExpression)) {
            const optimized = this.createDependency(keyPath);
            if (optimized) {
              mergeDependencies(condition, optimized.deps);
              element.node.key = optimized.expr;
            }
          }
        }
      } else if (isPathValid(element, t.isSpreadElement)) {
        const optimized = this.createDependency(element.get('argument'));
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          element.node.argument = optimized.expr;
        }
      } else if (isPathValid(element, t.isObjectMethod)) {
        const bindings = getForeignBindings(path);
        const dependencies = createDependencies();
        forEach(bindings, (binding) => {
          const optimized = this.memoizeIdentifier(path, binding);
          mergeDependencies(dependencies, optimized.deps);
        });
        mergeDependencies(condition, dependencies);
      }
    });

    return this.createMemo(path.node, condition);
  }

  optimizeNewExpression(
    path: babel.NodePath<t.NewExpression>,
  ) {
    const calleePath = path.get('callee');
    if (isPathValid(calleePath, t.isExpression)) {
      // Build dependencies
      const condition = createDependencies();
      const callee = this.createDependency(calleePath);
      if (callee) {
        path.node.callee = callee.expr;
        mergeDependencies(condition, callee.deps);
      }
      const argumentsPath = path.get('arguments');
      forEach(argumentsPath, (argument, i) => {
        if (isPathValid(argument, t.isExpression)) {
          const optimized = this.createDependency(argument);
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            path.node.arguments[i] = optimized.expr;
          }
        } else if (isPathValid(argument, t.isSpreadElement)) {
          const optimized = this.createDependency(argument.get('argument'));
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            argument.node.argument = optimized.expr;
          }
        }
      });
      return this.createMemo(path.node, condition);
    }
    return optimizedExpr(path.node);
  }

  optimizeSequenceExpression(
    path: babel.NodePath<t.SequenceExpression>,
  ) {
    forEach(path.get('expressions'), (expr, i) => {
      const result = this.optimizeExpression(expr);
      path.node.expressions[i] = result.expr;
    });
    return optimizedExpr(path.node);
  }

  memoizeTemplateLiteral(
    path: babel.NodePath<t.TemplateLiteral>,
  ) {
    const conditions = createDependencies();
    forEach(path.get('expressions'), (expr, i) => {
      if (isPathValid(expr, t.isExpression)) {
        const dependency = this.createDependency(expr);
        if (dependency) {
          path.node.expressions[i] = dependency.expr;
          mergeDependencies(conditions, dependency.deps);
        }
      }
    });
    return {
      expr: path.node,
      deps: conditions,
    };
  }

  optimizeTemplateLiteral(
    path: babel.NodePath<t.TemplateLiteral>,
  ) {
    const result = this.memoizeTemplateLiteral(path);
    return this.createMemo(result.expr, result.deps);
  }

  optimizedTaggedTemplateExpression(
    path: babel.NodePath<t.TaggedTemplateExpression>,
  ) {
    const conditions = createDependencies();
    const tag = this.createDependency(path.get('tag'));
    if (tag) {
      mergeDependencies(conditions, tag.deps);
      path.node.tag = tag.expr;
    }
    const quasi = this.memoizeTemplateLiteral(path.get('quasi'));
    mergeDependencies(conditions, quasi.deps);
    path.node.quasi = quasi.expr;

    return this.createMemo(path.node, conditions);
  }

  memoizeJSXChildren(
    path: babel.NodePath<t.JSXFragment | t.JSXElement>,
  ) {
    const conditions = createDependencies();
    forEach(path.get('children'), (child, i) => {
      if (isPathValid(child, t.isJSXFragment)) {
        const optimized = this.createDependency(child);
        if (optimized) {
          path.node.children[i] = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(conditions, optimized.deps);
        }
      } else if (isPathValid(child, t.isJSXElement)) {
        const optimized = this.createDependency(child);
        if (optimized) {
          path.node.children[i] = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(conditions, optimized.deps);
        }
      } else if (isPathValid(child, t.isJSXExpressionContainer)) {
        const expr = child.get('expression');
        if (isPathValid(expr, t.isExpression)) {
          const optimized = this.createDependency(expr);
          if (optimized) {
            child.node.expression = optimized.expr;
            mergeDependencies(conditions, optimized.deps);
          }
        }
      }
    });

    return conditions;
  }

  optimizeJSXFragment(
    path: babel.NodePath<t.JSXFragment>,
  ) {
    if (this.ctx.preset.optimizeJSX) {
      const dependencies = this.memoizeJSXChildren(path);
      return this.createMemo(path.node, dependencies);
    }
    return optimizedExpr(path.node);
  }

  optimizeJSXElement(
    path: babel.NodePath<t.JSXElement>,
  ) {
    if (this.ctx.preset.optimizeJSX) {
      const dependencies = createDependencies();
      const attributes = path.get('openingElement').get('attributes');
      forEach(attributes, (attribute) => {
        if (isPathValid(attribute, t.isJSXAttribute)) {
          const value = attribute.get('value');
          if (value) {
            if (isPathValid(value, t.isJSXFragment)) {
              const optimized = this.createDependency(value);
              if (optimized) {
                attribute.node.value = t.jsxExpressionContainer(optimized.expr);
                mergeDependencies(dependencies, optimized.deps);
              }
            } else if (isPathValid(value, t.isJSXElement)) {
              const optimized = this.createDependency(value);
              if (optimized) {
                attribute.node.value = t.jsxExpressionContainer(optimized.expr);
                mergeDependencies(dependencies, optimized.deps);
              }
            } else if (isPathValid(value, t.isJSXExpressionContainer)) {
              const expr = value.get('expression');
              if (isPathValid(expr, t.isExpression)) {
                const optimized = this.createDependency(expr);
                if (optimized) {
                  value.node.expression = optimized.expr;
                  mergeDependencies(dependencies, optimized.deps);
                }
              }
            }
          }
        } else if (isPathValid(attribute, t.isJSXSpreadAttribute)) {
          const optimized = this.createDependency(attribute.get('argument'));
          if (optimized) {
            attribute.node.argument = optimized.expr;
            mergeDependencies(dependencies, optimized.deps);
          }
        }
      });
      if (path.node.children.length) {
        mergeDependencies(dependencies, this.memoizeJSXChildren(path));
      }
      return this.createMemo(path.node, dependencies);
    }
    return optimizedExpr(path.node);
  }

  optimizeExpression(
    path: babel.NodePath<t.Expression>,
  ): OptimizedExpression {
    while (isPathValid(path, isNestedExpression)) {
      path = path.get('expression');
    }
    // No need to optimize
    if (t.isLiteral(path.node) && !t.isTemplateLiteral(path.node)) {
      return optimizedExpr(path.node, undefined, true);
    }
    // Only optimize for complex values
    if (isPathValid(path, isGuaranteedLiteral)) {
      return this.createMemo(path.node, true);
    }
    // if (t.isIdentifier(path.node)) {
    if (isPathValid(path, t.isIdentifier)) {
      return this.optimizeIdentifier(path);
    }
    if (
      isPathValid(path, t.isMemberExpression)
      || isPathValid(path, t.isOptionalMemberExpression)
    ) {
      return this.optimizeMemberExpression(path);
    }
    if (isPathValid(path, t.isConditionalExpression)) {
      return this.optimizeConditionalExpression(path);
    }
    if (isPathValid(path, t.isBinaryExpression)) {
      return this.optimizeBinaryExpression(path);
    }
    if (isPathValid(path, t.isLogicalExpression)) {
      return this.optimizeLogicalExpression(path);
    }
    if (isPathValid(path, t.isUnaryExpression)) {
      return this.optimizeUnaryExpression(path);
    }
    if (
      isPathValid(path, t.isCallExpression)
      || isPathValid(path, t.isOptionalCallExpression)
    ) {
      return this.optimizeCallExpression(path);
    }
    if (isPathValid(path, t.isAwaitExpression) || isPathValid(path, t.isYieldExpression)) {
      return this.optimizeAwaitYieldExpression(path);
    }
    if (
      isPathValid(path, t.isFunctionExpression)
      || isPathValid(path, t.isArrowFunctionExpression)
    ) {
      return this.optimizeFunctionExpression(path);
    }
    if (isPathValid(path, t.isAssignmentExpression)) {
      return this.optimizeAssignmentExpression(path);
    }
    if (isPathValid(path, t.isArrayExpression) || isPathValid(path, t.isTupleExpression)) {
      return this.optimizeArrayExpression(path);
    }
    if (isPathValid(path, t.isObjectExpression) || isPathValid(path, t.isRecordExpression)) {
      return this.optimizeObjectExpression(path);
    }
    if (isPathValid(path, t.isNewExpression)) {
      return this.optimizeNewExpression(path);
    }
    if (isPathValid(path, t.isSequenceExpression)) {
      return this.optimizeSequenceExpression(path);
    }
    if (isPathValid(path, t.isTaggedTemplateExpression)) {
      return this.optimizedTaggedTemplateExpression(path);
    }
    if (isPathValid(path, t.isTemplateLiteral)) {
      return this.optimizeTemplateLiteral(path);
    }
    if (isPathValid(path, t.isJSXFragment)) {
      return this.optimizeJSXFragment(path);
    }
    if (isPathValid(path, t.isJSXElement)) {
      return this.optimizeJSXElement(path);
    }
    return optimizedExpr(path.node, undefined, true);
  }

  optimizeExpressionStatement(
    path: babel.NodePath<t.ExpressionStatement>,
  ) {
    const optimized = this.optimizeExpression(path.get('expression'));
    this.scope.push(t.expressionStatement(optimized.expr));
  }

  optimizeVariableDeclaration(
    path: babel.NodePath<t.VariableDeclaration>,
  ) {
    forEach(path.get('declarations'), (declaration) => {
      const init = declaration.node.init
        ? this.optimizeExpression(
          declaration.get('init') as babel.NodePath<t.Expression>,
        ).expr
        : undefined;
      this.scope.push(
        t.variableDeclaration(
          path.node.kind,
          [
            t.variableDeclarator(
              declaration.node.id,
              init,
            ),
          ],
        ),
      );
    });
  }

  optimizeReturnStatement(
    path: babel.NodePath<t.ReturnStatement>,
  ) {
    if (path.node.argument) {
      const optimized = this.optimizeExpression(path.get('argument') as babel.NodePath<t.Expression>);
      path.node.argument = optimized.expr;
    }
    this.scope.push(path.node);
  }

  optimizeThrowStatement(
    path: babel.NodePath<t.ThrowStatement>,
  ) {
    const optimized = this.optimizeExpression(path.get('argument'));
    path.node.argument = optimized.expr;
    this.scope.push(path.node);
  }

  private optimizeBlock(
    path: babel.NodePath<t.BlockStatement>,
  ) {
    forEach(path.get('body'), (statement) => {
      this.optimizeStatement(statement);
    });
  }

  optimizeBlockStatement(
    path: babel.NodePath<t.BlockStatement>,
    topBlock = false,
  ) {
    if (topBlock) {
      this.optimizeBlock(path);
    } else {
      const parent = this.scope;
      const block = new OptimizerScope(this.ctx, path, parent);
      this.scope = block;
      this.optimizeBlock(path);
      this.scope = parent;
      this.scope.push(t.blockStatement(block.getStatements()));
    }
  }

  optimizeIfStatement(
    path: babel.NodePath<t.IfStatement>,
  ) {
    const optimized = this.optimizeExpression(path.get('test'));
    const parent = this.scope;
    const consequentPath = path.get('consequent');
    const consequent = new OptimizerScope(this.ctx, consequentPath, parent);
    this.scope = consequent;
    this.optimizeStatement(consequentPath, true);
    this.scope = parent;
    const newNode = t.ifStatement(optimized.expr, t.blockStatement(consequent.getStatements()));
    if (path.node.alternate) {
      const alternatePath = path.get('alternate') as babel.NodePath<t.Statement>;
      const alternate = new OptimizerScope(this.ctx, alternatePath, parent);
      this.scope = alternate;
      this.optimizeStatement(alternatePath, true);
      this.scope = parent;
      newNode.alternate = t.blockStatement(alternate.getStatements());
    }
    this.scope.push(newNode);
  }

  optimizeLoopStatement(
    path: babel.NodePath<t.Loop>,
  ) {
    const parent = this.scope;
    const loop = new OptimizerScope(this.ctx, path, parent, true);
    this.scope = loop;
    this.optimizeStatement(path.get('body'), true);
    this.scope = parent;

    const statements = loop.getStatements();

    const memoDeclaration = loop.getLoopMemoDeclaration();
    if (memoDeclaration) {
      this.scope.push(memoDeclaration);
    }

    path.node.body = t.blockStatement(statements);
    this.scope.push(path.node);
  }

  optimizeForXStatement(
    path: babel.NodePath<t.ForXStatement>,
  ) {
    const optimized = this.optimizeExpression(path.get('right'));
    path.node.right = optimized.expr;
    this.optimizeLoopStatement(path);
  }

  optimizeSwitchStatement(
    path: babel.NodePath<t.SwitchStatement>,
  ) {
    const discriminant = this.optimizeExpression(path.get('discriminant'));
    path.node.discriminant = discriminant.expr;

    const parent = this.scope;
    forEach(path.get('cases'), (current) => {
      const scope = new OptimizerScope(parent.ctx, current, parent);
      this.scope = scope;
      forEach(current.get('consequent'), (consequent) => {
        this.optimizeStatement(consequent);
      });
      this.scope = parent;
      current.node.consequent = scope.getStatements();
    });
    this.scope = parent;

    this.scope.push(path.node);
  }

  optimizeTryStatement(
    path: babel.NodePath<t.TryStatement>,
  ) {
    const parent = this.scope;
    const tryBlock = new OptimizerScope(this.ctx, path, parent);
    this.scope = tryBlock;
    this.optimizeBlock(path.get('block'));
    this.scope = parent;
    path.node.block = t.blockStatement(tryBlock.getStatements());

    if (path.node.handler) {
      const handler = path.get('handler') as babel.NodePath<t.CatchClause>;
      const catchClause = new OptimizerScope(this.ctx, handler, parent);
      this.scope = catchClause;
      this.optimizeBlock(handler.get('body'));
      this.scope = parent;
      handler.node.body = t.blockStatement(catchClause.getStatements());
    }
    if (path.node.finalizer) {
      const handler = path.get('finalizer') as babel.NodePath<t.BlockStatement>;
      const finalizerBlock = new OptimizerScope(this.ctx, handler, parent);
      this.scope = finalizerBlock;
      this.optimizeBlock(handler);
      this.scope = parent;
      path.node.finalizer = t.blockStatement(finalizerBlock.getStatements());
    }

    this.scope.push(path.node);
  }

  optimizeLabeledStatement(
    path: babel.NodePath<t.LabeledStatement>,
  ) {
    const parent = this.scope;
    const block = new OptimizerScope(this.ctx, path, parent);
    this.scope = block;
    this.optimizeStatement(path.get('body'));
    this.scope = parent;
    path.node.body = t.blockStatement(block.getStatements());
    this.scope.push(path.node);
  }

  optimizeStatement(
    path: babel.NodePath<t.Statement>,
    topBlock = false,
  ): void {
    if (isPathValid(path, t.isExpressionStatement)) {
      this.optimizeExpressionStatement(path);
    } else if (isPathValid(path, t.isVariableDeclaration)) {
      this.optimizeVariableDeclaration(path);
    } else if (isPathValid(path, t.isReturnStatement)) {
      this.optimizeReturnStatement(path);
    } else if (isPathValid(path, t.isThrowStatement)) {
      this.optimizeThrowStatement(path);
    } else if (isPathValid(path, t.isBlockStatement)) {
      this.optimizeBlockStatement(path, topBlock);
    } else if (isPathValid(path, t.isIfStatement)) {
      this.optimizeIfStatement(path);
    } else if (isPathValid(path, t.isForXStatement)) {
      this.optimizeForXStatement(path);
    } else if (isPathValid(path, t.isLoop)) {
      this.optimizeLoopStatement(path);
    } else if (isPathValid(path, t.isSwitchStatement)) {
      this.optimizeSwitchStatement(path);
    } else if (isPathValid(path, t.isTryStatement)) {
      this.optimizeTryStatement(path);
    } else if (isPathValid(path, t.isLabeledStatement)) {
      this.optimizeLabeledStatement(path);
    } else {
      this.scope.push(path.node);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  optimizeArrowComponent(
    path: babel.NodePath<t.ArrowFunctionExpression>,
  ) {
    path.replaceWith(
      t.functionExpression(
        path.scope.generateUidIdentifier('Component'),
        path.node.params,
        t.isStatement(path.node.body) ? path.node.body : t.blockStatement([
          t.returnStatement(path.node.body),
        ]),
      ),
    );
  }

  optimizeFunctionComponent(
    path: babel.NodePath<t.FunctionExpression | t.FunctionDeclaration>,
  ) {
    this.optimizeBlock(path.get('body'));
    path.node.body = t.blockStatement(this.scope.getStatements());
    path.skip();
  }

  optimize() {
    if (isPathValid(this.path, t.isArrowFunctionExpression)) {
      this.optimizeArrowComponent(this.path);
    } else if (
      isPathValid(this.path, t.isFunctionExpression)
      || isPathValid(this.path, t.isFunctionDeclaration)
    ) {
      this.optimizeFunctionComponent(this.path);
    }
  }
}
