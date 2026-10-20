// 只标记测试用户；不能提前导入 env，测试会在动态导入前设置 DATA_DIR。
Object.assign(globalThis, { __NOBOT_TEST_USER__: 'test' })
