// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockUniswapV3Pool {
    uint160 public sqrtPriceX96;

    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        sqrtPriceX96 = _sqrtPriceX96;
    }

    function slot0() external view returns (
        uint160,
        int24,
        uint16,
        uint16,
        uint16,
        uint8,
        bool
    ) {
        return (
            sqrtPriceX96,
            0, // tick
            0, // observationIndex
            1, // observationCardinality
            1, // observationCardinalityNext
            0, // feeProtocol
            true // unlocked
        );
    }
}