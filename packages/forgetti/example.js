import * as babel from '@babel/core';
import plugin from 'forgetti';

const options = {
  preset: 'react',
};

async function compile(code) {
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

console.log(await compile(`
function Example() {
  const a = Math.random();
  const b = Math.random();
  console.log(a + b);
}
`));