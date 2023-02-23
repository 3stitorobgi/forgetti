/* eslint-disable no-template-curly-in-string */
import * as babel from '@babel/core';
import { describe, expect, it } from 'vitest';
import plugin, { Options } from '../src';

const options: Options = {
  shouldCheckComponentName: true,
  memo: {
    name: 'useMemo',
    source: 'react',
    kind: 'named',
  },
  hooks: [
    {
      type: 'memo',
      name: 'useMemo',
      source: 'react',
      kind: 'named',
    },
    {
      type: 'callback',
      name: 'useCallback',
      source: 'react',
      kind: 'named',
    },
    {
      type: 'effect',
      name: 'useEffect',
      source: 'react',
      kind: 'named',
    },
    {
      type: 'effect',
      name: 'useLayoutEffect',
      source: 'react',
      kind: 'named',
    },
  ],
  hocs: [],
};

async function compile(code: string) {
  const result = await babel.transformAsync(code, {
    plugins: [
      [plugin, options],
    ],
    parserOpts: {
      plugins: [
        'jsx',
      ],
    },
  });

  return result?.code ?? '';
}

describe('example', () => {
  it('should run', async () => {
    const code = `
import { useMemo, useEffect } from 'react';
function Example(props) {
  const message = props.greeting + ', ' + props.receiver;
  const example = useMemo(() => props.format(message), [message]);

  useEffect(() => {
    console.log(example);
  }, [example]);
}
    
`;
    expect(await compile(code)).toMatchSnapshot();
  });
});
