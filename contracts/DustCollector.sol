// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interface.sol";
import "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import "@uniswap/universal-router/lib/permit2/src/interfaces/IPermit2.sol";
import '@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol';
import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

contract DustCollector {
    address public routerAddr;
    address public uniRouterAddr;
    IUniversalRouter public universalRouter;
    IPermit2 public immutable permit2;
    address public permit2Addr;
    uint8 constant V2_SWAP_EXACT_IN = 0x08;
    uint8 constant V3_SWAP_EXACT_IN = 0x00;
    ISwapRouter public immutable swapRouterV3;
    uint24 public constant poolFee = 500;

    constructor(address _router, address _uni_router, address _permit2, ISwapRouter _swapRouter) {
        routerAddr = _router;
        uniRouterAddr = _uni_router;
        universalRouter = IUniversalRouter(_uni_router);
        permit2Addr = _permit2;
        permit2 = IPermit2(_permit2);
        swapRouterV3 = _swapRouter;
    }

    function  swapDust(address[] memory tokens, address to) external {

        IUniswapV2Router02 router = IUniswapV2Router02(routerAddr);
        address[] memory path = new address[](2);

        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amount = IERC20(otherToken).balanceOf( msg.sender );
            if(amount != 0) {
                IERC20(otherToken).transferFrom(msg.sender, address(this), amount);
                if(IERC20(otherToken).allowance(address(this), routerAddr) < amount) {
                    IERC20(otherToken).approve(routerAddr, type(uint256).max);
                }
                path[0] = otherToken;
                path[1] = to;
                uint256[] memory amounts = router.getAmountsOut(amount, path);
                uint256 tokenAmountEst = amounts[amounts.length - 1];
                tokenAmountEst = tokenAmountEst*80/100; //slippage 20%
                uint256[] memory amountsR = router.swapExactTokensForTokens(amount, tokenAmountEst, path, msg.sender, block.timestamp);
                require(amountsR[amountsR.length-1] >= tokenAmountEst, "amount smaller than estimate");
            }
        }
    }

    function  swapDustUni(address[] memory tokens, address to) external {
        address[] memory path = new address[](2);
        bytes[] memory inputs = new bytes[](1);

        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amount = IERC20(otherToken).balanceOf( msg.sender );
            IERC20(otherToken).transferFrom(msg.sender, address(this), amount);
            IERC20(otherToken).approve(address(permit2), type(uint256).max);
            permit2.approve(
            otherToken,
            address(universalRouter),
            type(uint160).max,
            type(uint48).max
            );

            bytes memory commands = abi.encodePacked(
                bytes1(uint8(V2_SWAP_EXACT_IN))
            );
            path[0] = otherToken;
            path[1] = to;
            inputs[0] = abi.encode(address(msg.sender), amount, 0, path, true);

            uint256 deadline = block.timestamp + 1800;

            universalRouter.execute(commands, inputs, deadline);
        }
    }

    function  swapDustV3(address[] memory tokens, address to) external {
        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amountIn = IERC20(otherToken).balanceOf( msg.sender );
        // msg.sender must approve this contract

        // Transfer the specified amount of DAI to this contract.
        TransferHelper.safeTransferFrom(otherToken, msg.sender, address(this), amountIn);

        // Approve the router to spend DAI.
        TransferHelper.safeApprove(otherToken, address(swapRouterV3), amountIn);

        // Naively set amountOutMinimum to 0. In production, use an oracle or other data source to choose a safer value for amountOutMinimum.
        // We also set the sqrtPriceLimitx96 to be 0 to ensure we swap our exact input amount.
        ISwapRouter.ExactInputSingleParams memory params =
            ISwapRouter.ExactInputSingleParams({
                tokenIn: otherToken,
                tokenOut: to,
                fee: poolFee,
                recipient: msg.sender,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

            // The call to `exactInputSingle` executes the swap.
            swapRouterV3.exactInputSingle(params);
        }
    }

    function  swapDustV3Uni(address[] memory tokens, address to) external {
        bytes[] memory inputs = new bytes[](1);
        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amount = IERC20(otherToken).balanceOf( msg.sender );
            IERC20(otherToken).transferFrom(msg.sender, address(this), amount);
            IERC20(otherToken).approve(address(permit2), type(uint256).max);
            permit2.approve(
            otherToken,
            address(universalRouter),
            type(uint160).max,
            type(uint48).max
            );

            bytes memory commands = abi.encodePacked(
                bytes1(uint8(V3_SWAP_EXACT_IN))
            );
            inputs[0] = abi.encode(address(msg.sender), amount, 0,
            bytes.concat(
                bytes20(otherToken),
                bytes3(uint24(poolFee)),
                bytes20(to)
            ), true);

            uint256 deadline = block.timestamp + 1800;

            universalRouter.execute(commands, inputs, deadline);
        }
    }
}
