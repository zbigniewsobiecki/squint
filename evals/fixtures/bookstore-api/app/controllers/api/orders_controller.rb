module Api
  class OrdersController < BaseController
    before_action :set_order, only: [:show]

    def index
      orders = paginate(current_user.orders.order(created_at: :desc))
      render_success(orders.map { |o| OrderSerializer.new(o).as_json })
    end

    def show
      render_success(OrderSerializer.new(@order).as_json)
    end

    def create
      service = CheckoutService.new(
        user: current_user,
        items: order_params[:items]
      )

      result = service.call

      if result.success?
        render_success(OrderSerializer.new(result.order).as_json, status: :created)
      else
        render_error(result.error)
      end
    end

    private

    def set_order
      @order = current_user.orders.find_by(id: params[:id])
      render_not_found('Order') unless @order
    end

    def order_params
      params.require(:order).permit(items: [:book_id, :quantity])
    end
  end
end
